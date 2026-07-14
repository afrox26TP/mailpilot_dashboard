import os
import re
import secrets
from pathlib import Path

import mailchimp_marketing as MailchimpMarketing
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.exceptions import HTTPException

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
app = Flask(__name__, static_folder=str(FRONTEND_DIST), static_url_path="")
CORS(app, resources={r"/api/*": {"origins": os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")}})
limiter = Limiter(get_remote_address, app=app, default_limits=["120 per minute"], storage_uri="memory://")

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


@app.before_request
def require_authentication():
    username = os.getenv("APP_USERNAME", "").strip()
    password = os.getenv("APP_PASSWORD", "")
    if app.testing or not username or not password:
        return None

    auth = request.authorization
    valid = (
        auth is not None
        and secrets.compare_digest(auth.username or "", username)
        and secrets.compare_digest(auth.password or "", password)
    )
    if valid:
        return None
    return Response(
        "Přihlášení je vyžadováno.",
        401,
        {"WWW-Authenticate": 'Basic realm="MailPilot", charset="UTF-8"'},
    )


def mailchimp_client():
    api_key = os.getenv("MAILCHIMP_API_KEY", "").strip()
    server = os.getenv("MAILCHIMP_SERVER_PREFIX", "").strip()
    if not api_key or not server:
        raise RuntimeError("Chybí MAILCHIMP_API_KEY nebo MAILCHIMP_SERVER_PREFIX v souboru .env.")

    client = MailchimpMarketing.Client()
    client.set_config({"api_key": api_key, "server": server})
    return client


def required_text(data, field, label, max_length):
    value = str(data.get(field, "")).strip()
    if not value:
        raise ValueError(f"Pole „{label}“ je povinné.")
    if len(value) > max_length:
        raise ValueError(f"Pole „{label}“ může mít nejvýše {max_length} znaků.")
    return value


def campaign_payload(data):
    list_id = required_text(data, "listId", "publikum", 100)
    title = required_text(data, "title", "název kampaně", 150)
    subject = required_text(data, "subject", "předmět", 150)
    from_name = required_text(data, "fromName", "jméno odesílatele", 100)
    reply_to = required_text(data, "replyTo", "e-mail pro odpovědi", 254)
    html = required_text(data, "html", "obsah e-mailu", 200_000)
    preview_text = str(data.get("previewText", "")).strip()

    if not EMAIL_RE.match(reply_to):
        raise ValueError("E-mail pro odpovědi nemá platný formát.")
    if len(preview_text) > 150:
        raise ValueError("Náhledový text může mít nejvýše 150 znaků.")

    return {
        "type": "regular",
        "recipients": {"list_id": list_id},
        "settings": {
            "title": title,
            "subject_line": subject,
            "preview_text": preview_text,
            "from_name": from_name,
            "reply_to": reply_to,
        },
    }, html


def create_campaign(client, data):
    payload, html = campaign_payload(data)
    campaign = client.campaigns.create(payload)
    client.campaigns.set_content(campaign["id"], {"html": html})
    return campaign


@app.get("/api/health")
def health():
    configured = bool(os.getenv("MAILCHIMP_API_KEY") and os.getenv("MAILCHIMP_SERVER_PREFIX"))
    return jsonify({"ok": True, "configured": configured})


@app.get("/api/audiences")
@limiter.limit("30 per minute")
def audiences():
    result = mailchimp_client().lists.get_all_lists(count=1000)
    lists = [
        {
            "id": item["id"],
            "name": item["name"],
            "members": item.get("stats", {}).get("member_count", 0),
        }
        for item in result.get("lists", [])
    ]
    return jsonify({"audiences": lists})


@app.get("/api/campaigns")
@limiter.limit("30 per minute")
def campaigns():
    result = mailchimp_client().campaigns.list(count=10, sort_field="create_time", sort_dir="DESC")
    items = [
        {
            "id": item["id"],
            "title": item.get("settings", {}).get("title", "Bez názvu"),
            "subject": item.get("settings", {}).get("subject_line", ""),
            "status": item.get("status", "unknown"),
            "deliveryStatus": item.get("delivery_status", {}).get("status"),
            "sendTime": item.get("send_time") or item.get("create_time"),
            "emailsSent": item.get("emails_sent", 0),
        }
        for item in result.get("campaigns", [])
    ]
    return jsonify({"campaigns": items})


@app.get("/api/audiences/<list_id>/contacts")
@limiter.limit("30 per minute")
def contacts(list_id):
    result = mailchimp_client().lists.get_list_members_info(
        list_id, count=100, sort_field="last_changed", sort_dir="DESC"
    )
    members = [
        {
            "id": member["id"],
            "email": member.get("email_address", ""),
            "firstName": member.get("merge_fields", {}).get("FNAME", ""),
            "lastName": member.get("merge_fields", {}).get("LNAME", ""),
            "status": member.get("status", "unknown"),
            "lastChanged": member.get("last_changed"),
        }
        for member in result.get("members", [])
    ]
    return jsonify({"contacts": members, "total": result.get("total_items", len(members))})


@app.post("/api/audiences/<list_id>/contacts/import")
@limiter.limit("10 per hour")
def import_contacts(list_id):
    data = request.get_json(silent=True) or {}
    if data.get("consentConfirmed") is not True:
        raise ValueError("Musíte potvrdit, že všechny kontakty souhlasily s odběrem.")

    contacts_data = data.get("contacts")
    if not isinstance(contacts_data, list) or not contacts_data:
        raise ValueError("Seznam kontaktů je prázdný.")
    if len(contacts_data) > 500:
        raise ValueError("Najednou lze importovat nejvýše 500 kontaktů.")

    members = []
    seen = set()
    for index, contact in enumerate(contacts_data, start=1):
        if not isinstance(contact, dict):
            raise ValueError(f"Kontakt na řádku {index} nemá platný formát.")
        email = str(contact.get("email", "")).strip().lower()
        if not EMAIL_RE.match(email):
            raise ValueError(f"Neplatný e-mail na řádku {index}: {email or 'prázdná hodnota'}.")
        if email in seen:
            continue
        seen.add(email)
        first_name = str(contact.get("firstName", "")).strip()[:100]
        last_name = str(contact.get("lastName", "")).strip()[:100]
        members.append(
            {
                "email_address": email,
                "status": "subscribed",
                "merge_fields": {"FNAME": first_name, "LNAME": last_name},
            }
        )

    result = mailchimp_client().lists.batch_list_members(
        list_id,
        {"members": members, "update_existing": False},
        skip_merge_validation=True,
    )
    errors = [
        {"email": item.get("email_address", ""), "message": item.get("error", "Neznámá chyba")}
        for item in result.get("errors", [])
    ]
    new_members = result.get("new_members", [])
    updated_members = result.get("updated_members", [])
    created_count = result.get(
        "total_created", len(new_members) if isinstance(new_members, list) else int(new_members or 0)
    )
    updated_count = result.get(
        "total_updated", len(updated_members) if isinstance(updated_members, list) else int(updated_members or 0)
    )
    return jsonify(
        {
            "ok": not errors,
            "submitted": len(members),
            "created": created_count,
            "updated": updated_count,
            "errors": errors,
        }
    )


@app.post("/api/campaigns/test")
@limiter.limit("10 per hour")
def send_test():
    data = request.get_json(silent=True) or {}
    test_email = required_text(data, "testEmail", "testovací e-mail", 254)
    if not EMAIL_RE.match(test_email):
        raise ValueError("Testovací e-mail nemá platný formát.")

    client = mailchimp_client()
    campaign = create_campaign(client, data)
    client.campaigns.send_test_email(
        campaign["id"], {"test_emails": [test_email], "send_type": "html"}
    )
    return jsonify({"ok": True, "campaignId": campaign["id"], "message": "Testovací e-mail byl odeslán."})


@app.post("/api/campaigns/send")
@limiter.limit("5 per hour")
def send_campaign():
    data = request.get_json(silent=True) or {}
    if data.get("confirmation") != "ODESLAT":
        raise ValueError("Ostré rozeslání nebylo potvrzeno.")

    client = mailchimp_client()
    campaign = create_campaign(client, data)
    client.campaigns.send(campaign["id"])
    return jsonify({"ok": True, "campaignId": campaign["id"], "message": "Kampaň byla předána Mailchimpu k odeslání."})


@app.errorhandler(Exception)
def handle_error(error):
    if isinstance(error, HTTPException):
        return jsonify({"error": error.description}), error.code
    if isinstance(error, ValueError):
        return jsonify({"error": str(error)}), 400
    if isinstance(error, RuntimeError):
        return jsonify({"error": str(error)}), 503

    detail = getattr(error, "text", None) or str(error)
    app.logger.exception("API error")
    return jsonify({"error": "Mailchimp požadavek selhal.", "detail": detail}), 502


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    if not FRONTEND_DIST.exists():
        return jsonify({"message": "Frontend není sestaven. Spusťte vývojový Vite server."}), 404
    requested = FRONTEND_DIST / path
    if path and requested.is_file():
        return send_from_directory(FRONTEND_DIST, path)
    return send_from_directory(FRONTEND_DIST, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
