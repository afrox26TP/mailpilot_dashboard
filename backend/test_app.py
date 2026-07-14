import os
import unittest
from unittest.mock import patch

os.environ.setdefault("MAILCHIMP_API_KEY", "test-key")
os.environ.setdefault("MAILCHIMP_SERVER_PREFIX", "us1")

from app import app  # noqa: E402


class ApiTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])

    def test_live_send_requires_confirmation(self):
        response = self.client.post("/api/campaigns/send", json={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("potvrzeno", response.get_json()["error"])

    @patch("app.mailchimp_client")
    def test_invalid_test_email_is_rejected_before_api_call(self, client_mock):
        response = self.client.post("/api/campaigns/test", json={"testEmail": "spatne"})
        self.assertEqual(response.status_code, 400)
        client_mock.assert_not_called()

    @patch("app.mailchimp_client")
    def test_campaigns_use_sdk_list_method(self, client_mock):
        client_mock.return_value.campaigns.list.return_value = {
            "campaigns": [
                {
                    "id": "campaign-1",
                    "status": "sent",
                    "delivery_status": {"status": "delivering"},
                    "settings": {},
                }
            ]
        }
        response = self.client.get("/api/campaigns")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["campaigns"][0]["deliveryStatus"], "delivering")
        client_mock.return_value.campaigns.list.assert_called_once_with(
            count=10, sort_field="create_time", sort_dir="DESC"
        )

    def test_contact_import_requires_consent(self):
        response = self.client.post(
            "/api/audiences/list-1/contacts/import",
            json={"contacts": [{"email": "jan@example.com"}]},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("souhlas", response.get_json()["error"])

    @patch("app.mailchimp_client")
    def test_contact_import_uses_batch_api(self, client_mock):
        client_mock.return_value.lists.batch_list_members.return_value = {
            "new_members": [{"email_address": "jan@example.com"}],
            "updated_members": [],
            "total_created": 1,
            "total_updated": 0,
            "errors": [],
        }
        response = self.client.post(
            "/api/audiences/list-1/contacts/import",
            json={
                "consentConfirmed": True,
                "contacts": [{"email": "Jan@Example.com", "firstName": "Jan", "lastName": "Novák"}],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["created"], 1)
        client_mock.return_value.lists.batch_list_members.assert_called_once_with(
            "list-1",
            {
                "members": [
                    {
                        "email_address": "jan@example.com",
                        "status": "subscribed",
                        "merge_fields": {"FNAME": "Jan", "LNAME": "Novák"},
                    }
                ],
                "update_existing": False,
            },
            skip_merge_validation=True,
        )


if __name__ == "__main__":
    unittest.main()
