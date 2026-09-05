# Disaster Recovery & Backup Restore Verification (AA)

## Recovery Objectives
- **RTO (Recovery Time Objective)**: 4 hours
- **RPO (Recovery Point Objective)**: 15 minutes (Database PITR)

## Restore Verification Tests
- [ ] **Test 1**: Restore primary PostgreSQL database from daily snapshot to an isolated staging environment and verify data integrity using `npm run readiness`.
- [ ] **Test 2**: Simulate complete region failure and boot the standby region in GCP/Firebase within RTO.
- [ ] **Test 3**: Verify encryption-at-rest keys are securely backed up in a secondary KMS region.

## Idempotency and Resend Handling
- Following a recovery, the `outbox_messages` table will prevent duplicate outbound emails. Ensure the ActionGateway idempotency keys are verified against the provider immediately upon boot.
