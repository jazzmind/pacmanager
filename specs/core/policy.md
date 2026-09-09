<!--
module: src/policy.js
type: core
status: implemented-reference
framework: node:test
-->
# Require precise revocable authority

## Overview
PAC-003: Require precise revocable authority.

## Acceptance Criteria
- PAC-003: Only an exact valid user/artifact/digest/operation/binding grant permits the call.

## Scenarios
### Scenario 1: PAC-003
**Steps:**
1. Evaluate a declared mock call with absent, valid, wrong-user, stale, expired and revoked grants.

**Expected Results:**
- Only an exact valid user/artifact/digest/operation/binding grant permits the call.

## Security Notes
This is an offline reference, not runtime isolation or trusted authentication.

