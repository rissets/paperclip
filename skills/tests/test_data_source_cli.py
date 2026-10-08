import importlib.util
import hashlib
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
    def test_structured_catalog_exposes_physical_clickhouse_table(self):
        source = {
            "id": "source-1",
            "name": "Network KPIs",
            "sourceType": "csv",
            "status": "ready",
            "tables": [{
                "id": "table-1",
                "tableName": "06_datacom_device_inventory",
                "rowCount": 59,
                "columnCount": 8,
                "semanticModel": {"clickhouseTable": "ds_0123456789abcdef01234567_06_datacom_device_invent"},
            }],
        }
        output = io.StringIO()
        with patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--list-tables", "--company-id", "company-1", "--format", "json",
        ]), patch.object(query_structured, "make_request", return_value=[source]), redirect_stdout(output):
            query_structured.main()

        self.assertEqual(len(output.getvalue().splitlines()), 1)
        table = json.loads(output.getvalue())[0]
        self.assertEqual(table["Table Name"], "06_datacom_device_inventory")
        self.assertEqual(table["ClickHouse Table"], "ds_0123456789abcdef01234567_06_datacom_device_invent")
        self.assertEqual(table["tableId"], "table-1")
        self.assertEqual(table["dataSourceId"], "source-1")
        self.assertEqual(table["rowCount"], 59)
        self.assertEqual(table["clickhouseTable"], table["ClickHouse Table"])

    def test_structured_auto_allows_acl_scoped_schema_description(self):
        source = {
            "id": "source-1",
            "name": "Network KPIs",
            "sourceType": "csv",
            "status": "ready",
            "tables": [{
                "id": "table-1",
                "tableName": "ran_metrics",
                "rowCount": 5,
                "columnCount": 1,
                "schemaDefinition": [{"name": "sinr", "dataType": "number", "role": "metric"}],
                "semanticModel": {"clickhouseTable": "ds_source_ran_metrics"},
            }],
        }
        output = io.StringIO()
        with patch.dict(query_structured.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
            "PAPERCLIP_DATA_SOURCES_MODE": "selected",
            "PAPERCLIP_ASSIGNED_DATA_SOURCES": "source-1",
        }), patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--describe-table", "table-1", "--data-source-id", "source-1",
            "--company-id", "company-1", "--agent-id", "agent-1", "--format", "json",
        ]), patch.object(query_structured, "make_request", return_value=source) as mock_req, redirect_stdout(output):
            query_structured.main()

        mock_req.assert_called_once()
        self.assertIn("/data-sources/source-1", mock_req.call_args.args[0])
        self.assertEqual(mock_req.call_args.kwargs["agent_id"], "agent-1")
        self.assertEqual(json.loads(output.getvalue())["schemaDefinition"][0]["name"], "sinr")

    def test_structured_auto_allows_acl_filtered_catalog_metadata(self):
        source = {
            "id": "source-1",
            "name": "Network KPIs",
            "sourceType": "csv",
            "status": "ready",
            "tables": [{"id": "table-1", "tableName": "ran_metrics", "rowCount": 5}],
        }
        output = io.StringIO()
        with patch.dict(query_structured.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
            "PAPERCLIP_DATA_SOURCES_MODE": "selected",
            "PAPERCLIP_ASSIGNED_DATA_SOURCES": "source-1",
        }), patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--list-tables", "--company-id", "company-1",
            "--agent-id", "agent-1", "--format", "json",
        ]), patch.object(query_structured, "make_request", return_value=[source]) as mock_req, redirect_stdout(output):
            query_structured.main()

        mock_req.assert_called_once()
        self.assertEqual(json.loads(output.getvalue())[0]["tableId"], "table-1")

    def test_structured_catalog_derives_the_same_physical_name_as_server_fallback(self):
        table = {"id": "table-1", "tableName": "06_datacom_device_inventory", "semanticModel": {}}
        self.assertEqual(
            query_structured.clickhouse_table_name(table),
            "ds_" + hashlib.sha256(b"table-1").hexdigest()[:24] + "_06_datacom_device_invent",
        )

    def test_structured_request_can_wait_for_server_side_clickhouse_limit(self):
        with patch.object(query_structured.urllib.request, "urlopen", return_value=JsonResponse()) as urlopen:
            result = query_structured.make_request(
                "http://localhost/api/query",
                timeout_seconds=70,
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 70)

    def test_structured_orchestrate_invokes_orchestrator_query_executions(self):
        execution_response = {
            "id": "exec-123",
            "status": "completed",
            "resultsSummary": "Total omzet adalah Rp 50.000.000",
            "traceId": "orch-trace-abc",
            "stageTimings": {
                "preflightMs": 10,
                "planningMs": 50,
                "databaseExecutionMs": 100,
                "totalMs": 160,
            },
            "data": [{"omzet": 50000000}],
        }
        output = io.StringIO()
        with patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--orchestrate", "Berapa total omzet?", "--company-id", "comp-1", "--format", "json",
        ]), patch.object(query_structured, "make_request", return_value=execution_response) as mock_req, redirect_stdout(output):
            query_structured.main()

        mock_req.assert_called_once()
        self.assertIn("/companies/comp-1/orchestrator/query-executions", mock_req.call_args[0][0])
        parsed = json.loads(output.getvalue())
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(parsed["status"], "completed")
        self.assertEqual(parsed["traceId"], "orch-trace-abc")

    def test_structured_aggregate_resolves_the_canonical_source_table_pair(self):
        source = {
            "id": "source-1",
            "name": "Orders",
            "tables": [{"id": "table-1", "tableName": "orders"}],
        }
        calls = []

        def fake_request(url, method="GET", payload=None, **_kwargs):
            calls.append((url, method, payload))
            if url.endswith("/data-sources"):
                return [source]
            return {"columns": ["sum_amount"], "rows": [{"sum_amount": 18}], "totalRows": 1}

        output = io.StringIO()
        with patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--aggregate", "sum", "--column", "amount",
            "--table", "table-1", "--data-source-id", "source-1",
            "--company-id", "company-1", "--format", "json",
        ]), patch.object(query_structured, "make_request", side_effect=fake_request), redirect_stdout(output):
            query_structured.main()

        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1][0].endswith("/data-sources/source-1/tables/table-1/query"))
        self.assertEqual(json.loads(output.getvalue())["rows"], [{"sum_amount": 18}])
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_structured_auto_requires_orchestrator_or_specific_fallback_reason(self):
        output = io.StringIO()
        errors = io.StringIO()
        with patch.dict(query_structured.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
        }), patch.object(query_structured.sys, "argv", [
            "query_structured.py", "--sql", "SELECT 1", "--company-id", "company-1", "--format", "json",
        ]), redirect_stdout(output), redirect_stderr(errors), self.assertRaises(SystemExit) as raised:
            query_structured.main()

        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(len(errors.getvalue().splitlines()), 1)
        error = json.loads(errors.getvalue())
        self.assertEqual(error["error"]["code"], "orchestration_required")

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

    def test_database_orchestrate_invokes_orchestrator_query_executions(self):
        execution_response = {
            "id": "exec-456",
            "status": "completed",
            "resultsSummary": "Total users adalah 1.000",
            "traceId": "orch-trace-db",
            "stageTimings": {
                "preflightMs": 5,
                "planningMs": 20,
                "databaseExecutionMs": 50,
                "totalMs": 75,
            },
            "data": [{"users": 1000}],
        }
        output = io.StringIO()
        with patch.dict(query_database.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
        }), patch.object(query_database.sys, "argv", [
            "query_database.py", "--orchestrate", "Berapa total users?", "--company-id", "comp-1", "--format", "json",
        ]), patch.object(query_database, "make_request", return_value=execution_response) as mock_req, redirect_stdout(output):
            query_database.main()

        mock_req.assert_called_once()
        self.assertIn("/companies/comp-1/orchestrator/query-executions", mock_req.call_args[0][0])
        parsed = json.loads(output.getvalue())
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(parsed["status"], "completed")
        self.assertEqual(parsed["traceId"], "orch-trace-db")

    def test_database_auto_allows_acl_scoped_schema_description(self):
        source = {
            "id": "source-1",
            "name": "Telecom DB",
            "sourceType": "postgres",
            "status": "ready",
            "tables": [{
                "id": "table-1",
                "tableName": "ran_metrics",
                "rowCount": 5,
                "schemaDefinition": [{"name": "sinr", "dataType": "numeric", "role": "metric"}],
            }],
        }
        output = io.StringIO()
        with patch.dict(query_database.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
            "PAPERCLIP_DATA_SOURCES_MODE": "selected",
            "PAPERCLIP_ASSIGNED_DATA_SOURCES": "source-1",
        }), patch.object(query_database.sys, "argv", [
            "query_database.py", "--db", "source-1", "--describe-table", "table-1",
            "--company-id", "company-1", "--agent-id", "agent-1", "--format", "json",
        ]), patch.object(query_database, "make_request", return_value=[source]) as mock_req, redirect_stdout(output):
            query_database.main()

        mock_req.assert_called_once()
        self.assertEqual(mock_req.call_args.kwargs["agent_id"], "agent-1")
        self.assertEqual(json.loads(output.getvalue())["schemaDefinition"][0]["name"], "sinr")

    def test_database_auto_rejects_direct_sql_without_a_coordinator_fallback_reason(self):
        output = io.StringIO()
        errors = io.StringIO()
        with patch.dict(query_database.os.environ, {
            "PAPERCLIP_DATASOURCE_ORCHESTRATION_MODE": "auto",
        }), patch.object(query_database.sys, "argv", [
            "query_database.py", "--query-sql", "SELECT 1", "--db", "source-1",
            "--company-id", "company-1", "--format", "json",
        ]), redirect_stdout(output), redirect_stderr(errors), self.assertRaises(SystemExit) as raised:
            query_database.main()

        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(len(errors.getvalue().splitlines()), 1)
        error = json.loads(errors.getvalue())
        self.assertEqual(error["error"]["code"], "orchestration_required")


if __name__ == "__main__":
    unittest.main()
