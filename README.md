# MailPilot

Webová aplikace pro přípravu a hromadné odesílání Mailchimp kampaní. Frontend používá React + JavaScript (bez TypeScriptu), backend Python + Flask. API klíč se nikdy neposílá do prohlížeče.

## Funkce

- načtení existujících Mailchimp publik a počtu kontaktů,
- ruční vložení kontaktů nebo import CSV přímo do vybraného publika,
- HTML editor s bezpečně izolovaným náhledem,
- testovací e-mail před ostrým rozesláním,
- potvrzení slovem `ODESLAT` před odesláním celému publiku,
- přehled posledních kampaní a stavů,
- validace vstupů, omezení požadavků a srozumitelné chyby,
- responzivní české rozhraní.

> Rozesílejte pouze kontaktům, které k odběru udělily souhlas. Odhlášení a suppression kontakty spravuje Mailchimp v daném publiku.

## Import kontaktů

V horní části dashboardu vyberte publikum a použijte panel **Kontakty publika**. Kontakty lze vložit po řádcích nebo nahrát jako CSV/TXT. Podporovaný formát je:

    email; jméno; příjmení
    jan@firma.cz; Jan; Novák
    petra@firma.cz; Petra; Svobodová

Povinný je pouze e-mail. Před importem je nutné potvrdit, že všechny vkládané kontakty výslovně souhlasily s odběrem. Aplikace záměrně neobnovuje dříve odhlášené kontakty.

## 1. Mailchimp nastavení

1. V Mailchimpu otevřete **Profile → Extras → API keys** a vytvořte API klíč.
2. Zkopírujte `.env.example` jako `.env`.
3. Do `MAILCHIMP_API_KEY` vložte klíč.
4. Do `MAILCHIMP_SERVER_PREFIX` vložte datové centrum z konce klíče, například `us21`.
5. V publiku Mailchimpu ověřte výchozí adresu odesílatele a povinné kontaktní údaje v patičce.

Soubor `.env` je ignorovaný Gitem a nesmí se publikovat.

## 2. Backend (PowerShell)

V kořeni projektu vytvořte prostředí a nainstalujte závislosti:

    py -m venv .venv
    .\.venv\Scripts\Activate.ps1
    pip install -r backend\requirements.txt
    python backend\app.py

Backend poběží na `http://localhost:5000`.

## 3. Frontend (druhý terminál)

    cd frontend
    npm install
    npm run dev

Aplikaci otevřete na `http://localhost:5173`.

## Testy a produkční sestavení

    .\.venv\Scripts\python.exe -m unittest discover -s backend -p "test_*.py"
    npm --prefix frontend run build

Po sestavení frontend obslouží přímo Flask na portu 5000. Pro produkci nastavte `FLASK_DEBUG=0`, bezpečný `FRONTEND_ORIGIN` a spusťte například Gunicornem na Linuxu:

    gunicorn --chdir backend app:app

## Bezpečnost odesílání

Ostré rozeslání vyžaduje potvrzovací dialog a backend navíc kontroluje hodnotu `ODESLAT`. Opakované požadavky jsou omezené. Pokud Mailchimp kampaň odmítne, rozhraní zobrazí detail jeho chyby (např. neověřený odesílatel nebo chybějící fyzická adresa).

Pro veřejné nasazení vždy nastavte `APP_USERNAME` a silné náhodné `APP_PASSWORD`. Backend potom chrání frontend i všechny API endpointy HTTP Basic přihlášením. Doporučenou další vrstvou je Cloudflare Access omezený na konkrétní uživatelský e-mail.

## Cloudflare Tunnel

### Aktuální nasazení

- URL: **https://mailpilot.autoidx.cz**
- uživatelské jméno: `admin`
- heslo: hodnota `APP_PASSWORD` v lokálním souboru `.env`
- cílová služba tunelu: `http://127.0.0.1:5000`

Skutečné heslo není z bezpečnostních důvodů uloženo v README ani v repozitáři. Změníte ho úpravou `APP_PASSWORD` v `.env` a restartováním backendu. Přístupové údaje ukládejte do správce hesel.

Po sestavení frontendu lze celou Flask aplikaci zveřejnit tunelem směrovaným na `http://127.0.0.1:5000`. Příklad samostatné konfigurace:

        tunnel: ID_TUNELU
        credentials-file: C:\Users\uzivatel\.cloudflared\ID_TUNELU.json
        ingress:
            - hostname: mailpilot.example.cz
                service: http://127.0.0.1:5000
            - service: http_status:404

Soubor s credentials ani `.env` nikdy neukládejte do repozitáře.
