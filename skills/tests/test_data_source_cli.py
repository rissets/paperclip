import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_script(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


query_structured = load_script(
    "query_structured",
    "data-sources-structured/scripts/query_structured.py",
)
query_database = load_script(
    "query_database",
    "database-integration/scripts/query_database.py",
)


class JsonResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"ok": true}'


class DataSourceCliTests(unittest.TestCase):
    def test_structured_request_can_wait_for_server_side_clickhouse_limit(self):
        with patch.object(query_structured.urllib.request, "urlopen", return_value=JsonResponse()) as urlopen:
            result = query_structured.make_request(
                "http://localhost/api/query",
                timeout_seconds=70,
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 70)

    def test_external_sql_uses_durable_query_job_and_fetches_result(self):
        calls = []

        def fake_request(url, method="GET", payload=None, **_kwargs):
            calls.append((url, method, payload))
            if method == "POST":
                return {"success": True, "data": {"id": "job-1", "status": "queued"}}
            if url.endswith("/job-1"):
                return {"success": True, "data": {"id": "job-1", "status": "succeeded"}}
            if url.endswith("/job-1/result"):
                return {"success": True, "data": {"columns": ["count"], "rows": [{"count": 3}], "rowCount": 1}}
            self.fail(f"Unexpected query job request: {method} {url}")

        with patch.object(query_database, "make_request", side_effect=fake_request), patch.object(
            query_database.time, "sleep", return_value=None
        ):
            result = query_database.run_durable_query_job(
                "http://localhost/api",
                "company-1",
                "source-1",
                "SELECT count(*) AS count FROM records",
                25,
                30_000,
                poll_interval_seconds=0,
            )

        self.assertEqual(result["rows"], [{"count": 3}])
        self.assertEqual(calls[0][1], "POST")
        self.assertEqual(calls[0][2]["rowLimit"], 25)
        self.assertEqual(calls[0][2]["statementTimeoutMs"], 30_000)
        self.assertTrue(any(url.endswith("/job-1/result") for url, _method, _payload in calls))

    def test_external_query_job_is_cancelled_when_polling_deadline_expires(self):
        calls = []

        def fake_request(url, method="GET", **_kwargs):
            calls.append((url, method))
            if method == "POST" and url.endswith("/query-jobs"):
                return {"data": {"id": "job-2", "status": "queued"}}
            if method == "GET":
                return {"data": {"id": "job-2", "status": "running"}}
            if method == "POST" and url.endswith("/job-2/cancel"):
                return {"data": {"id": "job-2", "status": "cancel_requested"}}
            self.fail(f"Unexpected query job request: {method} {url}")

        with patch.object(query_database, "make_request", side_effect=fake_request), patch.object(
            query_database.time, "monotonic", side_effect=[100, 117]
        ), patch.object(query_database.time, "sleep", return_value=None):
            with self.assertRaisesRegex(TimeoutError, "cancellation was requested"):
                query_database.run_durable_query_job(
                    "http://localhost/api",
                    "company-1",
                    "source-1",
                    "SELECT count(*) FROM records",
                    25,
                    1_000,
                )

        self.assertEqual(calls[-1], ("http://localhost/api/companies/company-1/data-sources/source-1/query-jobs/job-2/cancel", "POST"))


if __name__ == "__main__":
    unittest.main()
