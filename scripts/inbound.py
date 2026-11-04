"""Inbound mail classifier (owner 2026-11-04): a delivery error is NEVER a stop.
Same rules and fixtures as the JS/TS versions in every Jacaranda Labs business:
  bounce (address rejected: suppress, counts to the bounce brake) | soft (full/temporary: end quietly, counts as nothing)
  gone (unmonitored / left: end quietly, counts as nothing) | auto (out-of-office: ignore) | stop (a person opted out) | reply
Delivery reports and robots are recognised BEFORE anyone's words are read for "stop"."""
import re

DSN_FROM = re.compile(r"^(mailer-?daemon|mail-?daemon|postmaster|microsoftexchange[0-9a-f]*|mail\.?delivery\.?subsystem|bounces?)@", re.I)
DSN_SUBJECT = re.compile(r"(delivery status notification|undeliver(able|ed)|delivery (has )?failed|delivery failure|failure notice|returned mail|mail delivery (failed|failure|subsystem|system)|could not be delivered|not (been )?delivered|non-?delivery|message blocked|delivery delayed|warning: could not send)", re.I)
_REPLY_PREFIX = re.compile(r"^\s*(re|aw|sv|antw?)\s*:", re.I)
DSN_BODY = re.compile(r"^(diagnostic-code|final-recipient|action: (failed|delayed)|status: [45]\.\d)", re.I | re.M)
HARD = re.compile(r"(address not found|user unknown|unknown user|no such (user|mailbox|recipient|address)|does ?n[o’']t exist|doesn’t exist|recipient (address )?rejected|invalid (recipient|address|mailbox)|unknown (recipient|address)|address (is )?invalid|mailbox not found|\b5\.1\.[0-9]+\b|\b550[ -]5\.1|account (has been )?(disabled|deleted|terminated))", re.I)
HARD_BUT_FULL = re.compile(r"\b5\.2\.2\b|mailbox (is )?full|over quota", re.I)
SOFT = re.compile(r"(mailbox (is |was )?full|inbox (is |was )?full|over (its |the |their )?(storage )?quota|quota (exceeded|full)|exceeded (the |its |their )?(storage|quota|allocation)|out of (storage|space)|insufficient (storage|space)|storage (space )?(is )?full|temporar(y|ily)|try (again )?later|greylist|\b4\.\d\.\d+\b|\b5\.2\.2\b|currently unavailable|not available (right )?now|delivery (is )?delayed|still trying|will (retry|keep trying))", re.I)
GONE = re.compile(r"(no longer (with|at|employed|working|part of)|(has|have) left (the |our )?(company|organi[sz]ation|firm|business|team)|(this |the |my )?(e-?mail|mail|address|mailbox|inbox|account)( address)? (is |has been |was )?(no longer|not) (in use|monitored|active|valid|available|checked|being (monitored|checked|used))|(account|mailbox|address|inbox|e-?mail) (is |has been |was )?(deactivated|disabled|closed|discontinued|retired|suspended)|\bnot (being )?monitored\b|\bunmonitored\b|no longer (monitored|in use|active|checked|in operation))", re.I)
AUTO = re.compile(r"\b(out of (the )?office|automatic reply|auto-?reply|autoreply|auto-?response|away from (the |my )?(office|desk)|on (annual |parental |maternity |paternity |sick )?leave|currently (away|travel+ing|out)|limited access to (e-?mail|my e-?mail)|i am away|i'?m away|back in the office on|will (respond|reply|get back to you) (to your (e-?mail|message) )?(as soon as|when|on my return)|thank you for (your (e-?mail|message)|contacting)[^.]{0,60}(we|our team) will|this is an automated)\b", re.I)
AUTO_SUBJECT = re.compile(r"^(auto(matic)?[ -]?(reply|response)|out of (the )?office|ooo\b|away:|abwesenheit|r[ée]ponse automatique|respuesta autom)", re.I)
STOP_PHRASE = re.compile(r"\b(unsubscribe|remove me|take me off|opt(ed)? ?out|not interested|no,? thanks|no thank you|stop (emailing|writing|contacting|sending|messaging)|do not (email|contact|write|message)|don'?t (email|contact|write|message)|leave (me|us) alone|please stop|stop it|remove (us|me|our (address|e-?mail|details))( from)?)\b", re.I)
_QUOTE = [re.compile(p, re.I) for p in (r"^\s*>", r"^\s*On .{4,200}wrote:\s*$", r"^\s*On .{4,200}\d{4}.*<[^>]+@", r"^\s*-- ?$", r"^-{2,}\s*(original message|forwarded message)",
                                         r"^\s*(from|sent|von|de):\s", r"^\s*sent from my ", r"^_{5,}")]


def own_words(text: str) -> str:
    out = []
    for line in str(text or "").replace("\r", "").split("\n"):
        if any(p.search(line) for p in _QUOTE):
            break
        out.append(line)
    return "\n".join(out).strip()


def _stop_phrase(w: str) -> bool:
    """A stop phrase, unless negated: "don't stop emailing us" / "never stop sending" are compliments."""
    for m in STOP_PHRASE.finditer(w):
        before = w[max(0, m.start() - 16):m.start()]
        if m.group(0).lower().startswith("stop") and re.search(r"(don'?t|do not|never|n't)\s+$", before, re.I):
            continue
        return True
    return False


def is_stop(words: str) -> bool:
    w = str(words or "").strip()
    if not w:
        return False
    if re.match(r"^\W*(stop|unsubscribe|remove( me)?)\b", w, re.I):
        return True
    if re.match(r"^\W*(no|nope|nah)\b", w, re.I) and len(w) <= 60 and not GONE.search(w) and not SOFT.search(w):
        return True
    return _stop_phrase(w[:600])


def _h(headers, name: str) -> str:
    if not headers:
        return ""
    try:
        v = headers.get(name)
        if v is None:
            for k in list(headers.keys()):
                if str(k).lower() == name.lower():
                    v = headers[k]
                    break
        return str(v or "")
    except Exception:          # noqa: BLE001
        return ""


def classify_inbound(from_addr: str = "", subject: str = "", text: str = "", headers=None) -> tuple[str, str]:
    """-> (kind, why); kind in bounce|soft|gone|auto|stop|reply."""
    f, s, t = str(from_addr or "").lower().strip(), str(subject or ""), str(text or "")
    is_dsn = (bool(DSN_FROM.search(f)) or (bool(DSN_SUBJECT.search(s)) and not _REPLY_PREFIX.search(s)) or bool(DSN_BODY.search(t))
              or bool(re.search(r'report-type="?delivery-status', _h(headers, "content-type"), re.I)) or bool(_h(headers, "x-failed-recipients")))
    if is_dsn:
        blob = s + "\n" + t[:8000]
        if HARD.search(blob) and not HARD_BUT_FULL.search(blob):
            return "bounce", "address rejected"
        if SOFT.search(blob):
            return "soft", "temporary or full mailbox"
        if GONE.search(blob):
            return "gone", "inbox closed"
        return "bounce", "delivery failed"
    words = own_words(t)
    head = (s + "\n" + words)[:1500]
    asub = _h(headers, "auto-submitted").strip()
    auto_hdr = ((asub and asub.lower() != "no") or bool(_h(headers, "x-autoreply")) or bool(_h(headers, "x-autorespond"))
                or _h(headers, "precedence").strip().lower() in ("auto_reply", "bulk", "junk", "list"))
    if GONE.search(head):
        return "gone", "inbox closed or person left"
    if (auto_hdr or AUTO_SUBJECT.search(s) or AUTO.search(head)) and SOFT.search(head):
        return "soft", "mailbox full / unavailable"
    if auto_hdr or AUTO_SUBJECT.search(s):
        return "auto", "automatic reply"
    bare = re.sub(r"^((re|fwd?|aw|sv)\s*:\s*)+", "", s, flags=re.I).strip()
    if re.match(r"^\W*(stop|unsubscribe|remove me|opt ?out)\W*$", bare, re.I):
        return "stop", "asked not to be contacted"
    if is_stop(words):
        return "stop", "asked not to be contacted"
    if AUTO.search(head):
        return "auto", "automatic reply"
    if re.match(r"^(mailbox (is )?full|inbox (is )?full)", words, re.I):
        return "soft", "mailbox full"
    return "reply", "a person answered"
