"""`houston.monitoring`: its own spec file.

Co-located by phase 02b step 2b.13 out of `tests/test_services.py`,
which was 16,244 lines and 503 tests. Attributed by
`tools/attribute_tests.py`, which required a reference margin of two
AND a 60% share before moving anything.
"""
from __future__ import annotations
import json


def test_monitoring_ships_logs_stack():
    # Loki + OTel collector, mirroring RocketChat/rocketchat-compose; the
    # collector must be SCOPED to this repro's project so it never tails others.
    from houston import monitoring
    svcs = monitoring.services()
    assert "loki" in svcs and "opentelemetry-logs-collector" in svcs
    assert "loki_data" in monitoring.VOLUMES
    fs = dict(monitoring.files(["rocketchat"], project="houston-demo"))
    assert "monitoring/loki/config.yaml" in fs
    assert "monitoring/grafana/provisioning/datasources/loki.yml" in fs
    otel = fs["monitoring/otel/config.yaml"]
    assert "http://loki:3100/otlp" in otel              # exports to Loki
    assert 'com.docker.compose.project"] == "houston-demo"' in otel  # scoped to this repro


def test_monitoring_bind_ports_handles_portless_exporters():
    # Regression: the attach path binds ports over ALL monitoring services;
    # node-exporter/mongodb-exporter have no 'ports' key -> must not KeyError.
    from houston import monitoring
    bound = monitoring.bind_ports(monitoring.services(), "127.0.0.1")
    assert bound["prometheus"]["ports"] == ["127.0.0.1:9090:9090"]
    assert bound["grafana"]["ports"] == ["127.0.0.1:5050:3000"]
    assert "ports" not in bound["node-exporter"]
    assert "ports" not in bound["mongodb-exporter"]


def test_monitoring_ships_full_dashboards_and_exporter_targets():
    from houston import monitoring
    files = dict(monitoring.files(["rocketchat"]))
    dash = json.loads(files["monitoring/grafana/dashboards/rocketchat-metrics.json"])
    assert dash["title"] == "Rocket.Chat Metrics" and len(dash["panels"]) > 30
    # exporter dashboards shipped too
    assert "monitoring/grafana/dashboards/node-exporter-full.json" in files
    assert "monitoring/grafana/dashboards/mongodb-exporter.json" in files
    # exporter scrape targets present
    assert "mongodb-exporter:9216" in files["monitoring/file_sd_configs/mongo.yml"]
    assert "node-exporter:9100" in files["monitoring/file_sd_configs/node-exporter.yml"]


def test_monitoring_ships_k6_loadtest_dashboard():
    # loadtest --live streams k6_* metrics via remote-write; a dashboard must be
    # provisioned to actually SEE them (Explore alone is easy to miss).
    from houston import monitoring
    files = dict(monitoring.files(["rocketchat"]))
    raw = files.get("monitoring/grafana/dashboards/k6-loadtest.json")
    assert raw, "k6 load-test dashboard not shipped"
    dash = json.loads(raw)
    assert dash["title"] == "k6 Load Test" and dash["panels"]
    # its panels must actually query the k6_ metrics the --live push produces,
    # against the provisioned Prometheus datasource.
    body = json.dumps(dash)
    assert "k6_http_reqs_total" in body and "k6_http_req_duration_p95" in body
    assert "DS_PROMETHEUS" in body
