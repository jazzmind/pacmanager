<!--
module: src/contract.js
type: core
status: implemented-reference
framework: node:test
-->
# Reject unsafe or ambiguous contracts

## Overview
PAC-001: Reject unsafe or ambiguous contracts.

## Acceptance Criteria
- PAC-001: Valid input passes; malformed, duplicate and unknown security-relevant fields fail.

## Scenarios
### Scenario 1: PAC-001
**Steps:**
1. Validate the example and mutate its identity, image, resource names and unknown fields.

**Expected Results:**
- Valid input passes; malformed, duplicate and unknown security-relevant fields fail.

## Security Notes
This is an offline reference, not runtime isolation or trusted authentication.

