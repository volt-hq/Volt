# Privacy ledger backup and recovery

Owner: Jordan Hans. On September 9, 2026, Jordan approved an encrypted archive
on the existing External drive with its recovery password held separately in
his password manager.

## Verified snapshot

`/Volumes/External/VoltPrivacyBackups/privacy-ledger-20260909T151511Z.dmg`
contains the private `PrivacyRequests` tree as of that snapshot and a SHA-256 file manifest.
It uses macOS disk-image AES-256 encryption. The source is on the internal
FileVault volume; only the encrypted archive and a receipt were written to the
External drive. No cloud upload or backup of the recovery password occurred.

The archive rejected a wrong password. A read-only mount with checksum
verification succeeded, and all 20 ledger files copied into an isolated restore
directory matched the source SHA-256 hashes. The source remained unchanged
during the snapshot. The image was detached and temporary plaintext copies were
removed. Image and receipt are mode 0600 in a mode 0700 directory.

SHA-256: `309a229dbe60199277892cdb9428273c509c966d75a89527887c85039d2698ed`.

On September 9 Jordan confirmed that the archive opened successfully and he
saved its password in his password manager. Independent password custody is
confirmed by the owner. The private confirmation and latest snapshot receipt
are in `~/Library/Application Support/Volt/PrivacyRecovery/`; the password is
outside the ledger and its archive. Consult `latest-backup.json` for the most
recent verified archive, including later support-delivery confirmation.

The replacement `privacy-ledger-20260909T152343Z.dmg` includes those confirmations
and passed another full 20-file restore comparison. It uses the same password.
SHA-256: `ee42b38ef3c2c400848d600156f671d26ee542c93bdb3c4a19de0de66f4e66dc`.
The temporary password handoff file was removed after verification. The earlier
encrypted snapshot is retained and remains subject to the case retention rules.

## Owner handoff and restore

1. Save the handoff password in the owner's password manager, together with the
   exact archive filename. Retrieve it from there and use it to open this archive
   before confirming custody. Do not paste the password into chat, GitHub, email,
   shell arguments or the ledger itself. Remove the temporary handoff file only
   after the independently stored password has been verified.
2. To recover, verify the archive SHA-256 against its receipt, mount it read-only,
   and copy `PrivacyRequests` into a private directory on an encrypted volume.
   Verify each restored file against `manifest.json`; restrict directories to
   mode 0700 and files to mode 0600. Detach the image after use.
3. Review cases and updates since the snapshot date before restoring product
   data. Reconcile any later decisions from retained evidence and keep restored
   product services closed until applicable deletion replay is verified.

## Ongoing operation

This is one verified snapshot, not an automated backup service. Make and verify
a replacement after material case decisions or receipts change; check coverage
in the weekly due-case review. Use an encrypted image from the current ledger,
include a fresh file manifest, and verify its restore before retiring the old
snapshot. Preserve recovery password custody for every retained image.

Track snapshot contents and retention with the case inventory. An old ledger
archive must not extend an expired case's retention indefinitely: create a
verified replacement without expired material and retire affected old archives
when their remaining recovery obligations allow it. Record the actual removal.
No automatic rotation or reminders have been configured.

The External drive provides a separate disk copy, but is still a local backup.
This exercise does not establish an off-site disaster-recovery copy.
