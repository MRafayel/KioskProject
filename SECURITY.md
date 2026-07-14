# Security and privacy policy

Customer uploads are private, untrusted, and potentially malicious.

## Repository rules

- Never commit uploaded documents, previews, print-ready artifacts, database
  dumps, access tokens, private keys, production logs, or real payment data.
- Use only synthetic documents in automated tests.
- Keep local secrets in an ignored .env file. Commit names and safe
  placeholders only through .env.example.
- Do not put original customer filenames, document contents, QR tokens, or
  signed object URLs in logs.
- Treat a token, credential, or private document accidentally committed to Git
  as exposed. Revoke it and remove the data from all reachable history and
  backups.

## Vulnerability reporting

Do not place exploitable details or customer data in a public issue. Until a
private security mailbox is configured, report concerns directly to the project
owner through a private channel.

## Production gate

Before any public kiosk or real payment pilot, complete the security gates in
Phase 11 of docs/BUILD_PLAN.md, including threat modeling, kiosk OS hardening,
upload sandboxing, dependency and container scans, administrator MFA, audit
logging, retention verification, and an incident-response exercise.
