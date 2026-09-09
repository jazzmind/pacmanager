<!--
module: src/planner.js
type: core
status: implemented-reference
framework: node:test
-->
# Keep plans inert and deny by default

## Overview
PAC-002: Keep plans inert and deny by default.

## Acceptance Criteria
- PAC-002: The plan lists no ingress/egress grants and declares missing runtime blockers.

## Scenarios
### Scenario 1: PAC-002
**Steps:**
1. Generate a plan from the example.

**Expected Results:**
- The plan lists no ingress/egress grants and declares missing runtime blockers.

## Security Notes
This is an offline reference, not runtime isolation or trusted authentication.

