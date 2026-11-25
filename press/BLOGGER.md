# The Blogger lane, and the shared email pool

## One pool, every venture

Every email any venture sends goes through `press/blogger.py`'s `send()`:

```python
from press.blogger import send
send("someone@example.com", "Subject", "plain text", "<p>html</p>")
```

It sends as **simalidudu@gmail.com** (the estate's shared pool) over Gmail SMTP with the
device app password. Override with `EMAIL_POOL_ADDRESS` / `EMAIL_POOL_APP_PASSWORD` in
repo secrets if the pool ever moves. Nobody opens their own SMTP connection again: one
address, one password, one place to rotate.

Check it from a terminal:

```bash
python3 press/blogger.py --check
python3 press/blogger.py --send-test you@example.com
```

## The Blogger lane

Blogger's API needs an OAuth app and a refresh token per blog. This lane avoids all of
that by using **Mail2Blogger**: every Blogger blog has a secret posting address, and
anything emailed to it becomes a post.

Set two repo secrets to turn it on for a venture:

| secret | what it is |
| --- | --- |
| `BLOGGER_POST_EMAIL` | the blog's Mail2Blogger address (Blogger → Settings → Email) |
| `BLOGGER_BLOG_URL` | the public blog URL, recorded with each post |

Then the `.github/workflows/blogger-lane.yml` schedule (Mondays and Thursdays) takes the
next unpublished markdown file from `press/auto/outbox/` or `press/articles/`, converts it
to HTML, and mails it in from the pool. `press/state/blogger_published.json` records what
already went out, so nothing is posted twice.

Run it by hand any time:

```bash
python3 press/blogger.py --dry-run   # what would go out
python3 press/blogger.py --once      # send the next one
```

**Missing credentials are a soft skip.** With no `BLOGGER_POST_EMAIL`, the lane prints
`{"status": "skipped", ...}` and exits 0. Nothing in this repo should gate on it.
