"""Adds the in-app feedback routes to the live API proxy config. Writes a candidate file; installs nothing.

Usage: feedback-proxy.py CURRENT_CONFIG TEMPLATE OUTPUT

Takes the feedback rate-limit zone and the two feedback locations from TEMPLATE (this repository's nginx.conf),
adds them to CURRENT_CONFIG (the server's /etc/nginx/sites-available/tblink-licensing.conf) without touching
anything else, checks the result the way activate-release.py and publish-website.py check it on every later
deployment, and writes it to OUTPUT. The operator installs it, runs nginx -t and updates the policy digest.
"""
import hashlib
import importlib.util
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ACTIVATION_ZONE = "limit_req_zone $binary_remote_addr zone=tblink_activation:1m rate=30r/m;\n"
FEEDBACK_ZONE = "limit_req_zone $binary_remote_addr zone=tblink_feedback:1m rate=6r/m;\n"
LOCATIONS = "    # In-app problem reports."
FALLBACK = "    location / { return 404; }\n"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def template_parts(template):
    """The zone (with its comment line) and the two locations (with their comments), exactly as in TEMPLATE."""
    zone_end = template.index(FEEDBACK_ZONE) + len(FEEDBACK_ZONE)
    zone_start = template.rindex("\n", 0, template.index(FEEDBACK_ZONE) - 1) + 1
    start = template.index(LOCATIONS)
    end = template.index(FALLBACK, start)
    return template[zone_start:zone_end], template[start:end]


def add_feedback(current, template):
    release = load("activate_release", "activate-release.py")
    website = load("publish_website", "publish-website.py")
    if "/v1/feedback" in current or "tblink_feedback" in current:
        raise RuntimeError("Feedback routes are already present")
    if current.count(ACTIVATION_ZONE) != 1:
        raise RuntimeError("Expected exactly one activation rate-limit zone")
    zone, locations = template_parts(template)
    before, api, after = release.api_sections(current)
    if api.count(FALLBACK) != 1:
        raise RuntimeError("Expected one closed fallback in the API server")
    candidate = before.replace(ACTIVATION_ZONE, ACTIVATION_ZONE + zone, 1) + api.replace(FALLBACK, locations + FALLBACK, 1) + after
    # Every later deployment runs these on the live file; a candidate they reject must never be installed.
    release.next_proxy_config(candidate, candidate, candidate)
    release.maintenance_config(candidate)
    website.validate_config(candidate, candidate)
    return candidate


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: feedback-proxy.py CURRENT_CONFIG TEMPLATE OUTPUT")
    current, template, output = (Path(value) for value in sys.argv[1:])
    candidate = add_feedback(current.read_text(), template.read_text())
    output.write_text(candidate)
    print(f"candidate {output} sha256 {hashlib.sha256(candidate.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
