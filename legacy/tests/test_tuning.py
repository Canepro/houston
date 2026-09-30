"""Contracts for mutable tuning inputs used by deterministic tests."""

from houston.services import k8s
from houston.services import lifecycle as lc


def test_every_patched_production_tuning_value_lives_on_an_input_object():
    assert {
        "mongo_ready": k8s.tuning.MONGO_READY_TRIES,
        "cert_manager": k8s.tuning.CERT_MANAGER_TRIES,
        "cert_manager_webhook": k8s.tuning.CERT_MANAGER_WEBHOOK_TRIES,
        "issuer": k8s.tuning.ISSUER_WAIT_TRIES,
        "cloud_tools": k8s.tuning.CLOUD_PROVISION_TOOLS,
        "install_quiet": k8s.tuning.INSTALL_QUIET_S,
        "install_report": k8s.tuning.INSTALL_REPORT_EVERY_S,
        "foreign_port_strikes": lc.tuning.FOREIGN_PORT_STRIKES,
    } == {
        "mongo_ready": 60,
        "cert_manager": 20,
        "cert_manager_webhook": 60,
        "issuer": 20,
        "cloud_tools": {"eksctl": (0, 0)},
        "install_quiet": 30,
        "install_report": 30,
        "foreign_port_strikes": 4,
    }
