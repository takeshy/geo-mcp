#!/usr/bin/env python3
"""Conservative usage estimate; excludes free tiers and is not a billing cap."""
import argparse
p = argparse.ArgumentParser()
p.add_argument('--requests-per-day', type=int, default=100)
p.add_argument('--seconds-per-request', type=float, default=50)
p.add_argument('--update-hours', type=float, default=4)
p.add_argument('--updates-per-month', type=int, default=5)
p.add_argument('--other-usd', type=float, default=3, help='GCS, builds, images, DNS and traffic allowance; verify actual usage')
p.add_argument('--yen-per-usd', type=float, default=150)
a = p.parse_args()
# Assume every request uses both MCP and one router, including cold-start time.
serving = a.requests_per_day * 31 * a.seconds_per_request * (2 * .000024 + 5 * .0000025)
update = a.update_hours * a.updates_per_month * 3600 * (8 * .000018 + 32 * .000002)
total = (serving + update + a.other_usd) * a.yen_per_usd * 1.1
print(f'Serving: ${serving:.2f}; updates: ${update:.2f}; other allowance: ${a.other_usd:.2f}')
print(f'Estimated monthly total incl. 10% tax: JPY {total:,.0f} (FX assumption: {a.yen_per_usd})')
print('Not a hard cap: startup time, storage operations, retained snapshots and traffic must be measured.')
