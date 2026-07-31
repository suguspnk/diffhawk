# Notifier end-to-end test

This temporary, documentation-only change exists to verify the OpenMergeLens
review notification flow.

Expected behavior:

1. A scheduled or manual poll discovers the requested review.
2. OpenMergeLens reviews this pull request and creates a local report.
3. Clicking the notification opens the report in the machine's browser.
4. The report groups results by GitHub account, then repository.

This test pull request should be closed after verification, not merged.
