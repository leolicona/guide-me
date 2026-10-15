# Specification Quality Checklist: Drop the retired affiliate tables

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- A schema cleanup has no end-user surface: the spec names the database objects being removed
  because they ARE the scope, and names test suites because the constitution's scope boundary
  requires it. It prescribes the order of the drop because the order is the requirement (FR-001).
- Clarification resolved before writing: the developer settles the legacy user and its cash
  outside the product (*"se arreglan por fuera"*), so the guards for a stored retired role stay.
