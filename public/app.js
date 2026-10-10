/* Chuck's Daybook — page script. Polls this server's /api/data every 5 minutes. */
(function () {
  "use strict";
  var POLL = 5 * 60 * 1000, RETRY = 30 * 1000, DAYS = 14, DAY_MS = 864e5;
  var AVI = /\b(WINGS|FAASTeam|FAA|EAA|AOPA|ATC|CFI|VFR|IFR|IMC|pilots?|fly-?in|airport|airshow|Remos|N132GX|KHQU)\b/i;
  var CONF = /(^|\.)(zoom\.us|zoomgov\.com|teams\.microsoft\.com|webex\.com|meet\.google\.com)$/i;
  var DENIED = { setup: 1, reauth: 1, denied: 1 };
  var TV = /(^|[?&])tv(=|&|$)/.test(location.search.slice(1));

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function pad(n) { return String(n).padStart(2, "0"); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function isoLocal(d) {
    var o = -d.getTimezoneOffset(), a = Math.abs(o);
    return dayKey(d) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + (o >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
  }
  function dateOnly(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(NaN); }

  var fTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var fDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  var fDow = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  var fDowS = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  var fDate = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });
  var fDw1 = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  var fClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  function dur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    if (h < 24) return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
    return Math.floor(h / 24) + " d" + (h % 24 ? " " + (h % 24) + " h" : "");
  }
  function dayName(d, today) {
    var diff = Math.round((startOfDay(d) - today) / DAY_MS);
    return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : null;
  }
  function httpsUrl(s) {
    try { var u = new URL(String(s).trim().replace(/[.,;)\]]+$/, "")); return u.protocol === "https:" ? u : null; } catch (e) { return null; }
  }
  function confLabel(host) {
    if (/zoom/i.test(host)) return "Zoom";
    if (/meet\.google/i.test(host)) return "Google Meet";
    if (/teams\.microsoft/i.test(host)) return "Teams";
    if (/webex/i.test(host)) return "Webex";
    return host;
  }
  function senderName(s) {
    var t = String(s || "").replace(/\s+/g, " ").trim(), m = /^"?([^"<]*?)"?\s*<[^>]+>$/.exec(t);
    return (m && m[1].trim()) || t.replace(/[<>]/g, "") || "Unknown sender";
  }

  function normEvent(e) {
    if (!e || typeof e !== "object" || e.status === "cancelled" || !e.start) return null;
    var me = (e.attendees || []).filter(function (a) { return a && a.self; })[0];
    if (me && me.responseStatus === "declined") return null;
    if (e.eventType === "workingLocation") return null;
    var allDay = !!e.start.date && !e.start.dateTime, s, en;
    if (allDay) {
      s = dateOnly(e.start.date); en = dateOnly(e.end && e.end.date);
      if (isNaN(en) || en <= s) en = addDays(s, 1);
    } else {
      s = new Date(e.start.dateTime); en = new Date(e.end && e.end.dateTime);
      if (isNaN(en) || en < s) en = s;
    }
    if (isNaN(s)) return null;
    var loc = typeof e.location === "string" ? e.location.trim() : "";
    var desc = typeof e.description === "string" ? e.description : "";
    var text = [e.summary, desc, loc].join(" ");
    var locUrl = /^https?:\/\//i.test(loc) ? httpsUrl(loc) : null, join = null;
    if (locUrl && CONF.test(locUrl.hostname)) join = locUrl;
    if (!join) {
      var found = desc.match(/https:\/\/[^\s"'<>]+/g) || [];
      for (var i = 0; i < found.length && !join; i++) { var u = httpsUrl(found[i]); if (u && CONF.test(u.hostname)) join = u; }
    }
    var where = locUrl ? "Online · " + confLabel(locUrl.hostname) : /^https?:\/\//i.test(loc) ? "Online" : loc.replace(/\s*\n\s*/g, ", ");
    var link = httpsUrl(e.htmlLink);
    return {
      key: String(e.id || "") + "|" + s.getTime(), title: String(e.summary || "(No title)").trim(), allDay: allDay, s: s, e: en,
      link: link ? link.href : null, join: join ? join.href : null, joinLabel: join ? confLabel(join.hostname) : null,
      where: where, avi: AVI.test(text) || /faavideo\.zoomgov\.com/i.test(text)
    };
  }
  function normThread(t) {
    if (!t || !t.id || !isFinite(t.date)) return null;
    var link = httpsUrl(t.link);
    return {
      key: String(t.id), from: senderName(t.from), subject: String(t.subject || "").trim() || "(No subject)",
      when: new Date(Number(t.date)), count: Number(t.count) || 1, important: !!t.important,
      link: link && link.hostname === "mail.google.com" ? link.href : null
    };
  }

  var state = { loaded: false, fetching: false, lastTry: 0, netError: false, day: null, renderKey: "", cds: [] };
  var cal = { name: "Google Calendar", data: null, error: null, at: null };
  var mail = { name: "Gmail", data: null, error: null, at: null, more: false };
  var slots = [cal, mail];

  function apply(slot, part, field, norm, sort) {
    if (!part) return;
    slot.error = part.error || null;
    if (Array.isArray(part[field])) {
      slot.data = part[field].map(norm).filter(Boolean).sort(sort);
      slot.at = part.at; slot.more = !!part.more;
    } else if (slot.error && DENIED[slot.error.code]) { slot.data = null; slot.at = null; }
  }

  function load() {
    if (state.fetching) return;
    state.fetching = true; state.lastTry = Date.now();
    var start = startOfDay(new Date());
    state.day = dayKey(start);
    var q = "from=" + encodeURIComponent(isoLocal(start)) + "&to=" + encodeURIComponent(isoLocal(addDays(start, DAYS)));
    fetch("api/data?" + q, { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        state.netError = false;
        apply(cal, j.calendar, "events", normEvent, function (a, b) { return a.s - b.s; });
        apply(mail, j.mail, "threads", normThread, function (a, b) { return b.when - a.when; });
      })
      .catch(function () { state.netError = true; })
      .then(function () { state.fetching = false; state.loaded = true; render(true); });
  }

  function errCopy(slot) {
    var err = slot.error;
    switch (err.code) {
      case "setup": return "Google isn't authorized yet. Open this page's address with setup on the end (…/setup) and follow the steps in the guide.";
      case "reauth": return "Google's authorization expired or was revoked. Open …/setup again and put the new value in Render as GOOGLE_REFRESH_TOKEN.";
      case "denied": return slot.name + " refused access: " + (err.message || "no details") + ". Check that its API is enabled and that you ticked its box during setup.";
      default: return "Couldn't reach " + slot.name + " just now. " + (slot.data ? "Showing the last data that loaded." : "The page tries again shortly.");
    }
  }

  /* ---------- rendering ---------- */
  function waitText(slot, what) { return slot.error ? what + " unavailable." : state.netError ? "Can't reach the dashboard server." : "Loading…"; }
  function evState(ev, now) {
    if (ev.e <= now) return "done";
    if (ev.allDay) return "allday";
    return ev.s <= now ? "now" : "soon";
  }
  function whenText(ev, today) {
    var name = dayName(ev.s, today) || fDay.format(ev.s);
    if (ev.allDay) return name + ", all day";
    var same = dayKey(ev.s) === dayKey(ev.e);
    return name + ", " + fTime.format(ev.s) + " – " + (same ? fTime.format(ev.e) : fDay.format(ev.e) + " " + fTime.format(ev.e));
  }
  function cdText(ev, now) {
    return ev.s <= now ? "Ends " + fTime.format(ev.e) + " · " + dur(ev.e - now) + " left" : "In " + dur(ev.s - now);
  }
  function extLink(text, href, cls, title) {
    var a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; if (title) a.title = title; return a;
  }
  function metaInto(node, parts, ev) {
    parts.filter(Boolean).forEach(function (t, i) { if (i) node.append(" · "); node.append(t); });
    if (ev.join) { if (node.childNodes.length) node.append(" · "); node.append(extLink("Join on " + ev.joinLabel, ev.join)); }
  }
  function titleNode(text, link, title) { return link ? extLink(text, link, null, title) : el("span", null, text); }

  function bandBlock(ev, label, cls, now, today) {
    var d = el("div", cls);
    d.append(el("p", "band-label" + (ev.s <= now ? " is-now" : ""), label));
    var t = el("p", "band-title"); t.append(titleNode(ev.title, ev.link, "Open in Google Calendar")); d.append(t);
    var cd = el("p", "band-cd", cdText(ev, now)); state.cds.push({ node: cd, ev: ev }); d.append(cd);
    var m = el("p", "band-meta"); metaInto(m, [whenText(ev, today), ev.where], ev); d.append(m);
    return d;
  }
  function renderBand(now, today) {
    var box = $("band"); state.cds = [];
    box.replaceChildren();
    if (!cal.data) {
      box.append(el("p", "band-empty", cal.error ? "Your next event appears here once the calendar loads." : state.netError ? "Can't reach the dashboard server yet. It may be waking up; the page keeps trying." : "Loading your calendar…"));
      return;
    }
    var timed = cal.data.filter(function (e) { return !e.allDay; });
    var cur = timed.filter(function (e) { return e.s <= now && e.e > now && e.e - e.s < DAY_MS; })[0];
    var up = timed.filter(function (e) { return e.s > now; });
    var first = cur || up[0], second = cur ? up[0] : up[1];
    if (!first) { box.append(el("p", "band-empty", "Nothing else is scheduled in the next " + DAYS + " days.")); return; }
    box.append(bandBlock(first, cur ? "Happening now" : "Next up", "primary", now, today));
    if (second) box.append(bandBlock(second, "Then", "then", now, today));
  }

  function eventRow(ev, now, nextKey, dayStart) {
    var st = evState(ev, now), r = el("div", "ev " + st), t = el("div", "ev-time");
    var last = ev.allDay ? addDays(ev.e, -1) : ev.e, multi = dayKey(last) !== dayKey(ev.s);
    if (ev.allDay) t.append(el("span", "t1", "All day"));
    else if (ev.s < dayStart) t.append(el("span", "t1", "Ongoing"));
    else t.append(el("span", "t1", fTime.format(ev.s)), el("span", "t2", multi ? "→ " + fDowS.format(ev.e) : "– " + fTime.format(ev.e)));
    var body = el("div", "ev-body"), title = el("div", "ev-title");
    title.append(titleNode(ev.title, ev.link, "Open in Google Calendar"));
    if (st === "now") title.append(el("span", "pill p-now", "Now"));
    else if (ev.key === nextKey) title.append(el("span", "pill p-next", "Next"));
    if (ev.avi) title.append(el("span", "pill p-avi", "Aviation"));
    body.append(title);
    var through = multi ? (ev.allDay ? "through " + fDay.format(last) : "until " + fDay.format(last) + ", " + fTime.format(last)) : null;
    var meta = el("div", "ev-meta"); metaInto(meta, [ev.where, through], ev);
    if (meta.childNodes.length) body.append(meta);
    r.append(t, body); return r;
  }

  function renderSchedule(now, today) {
    var strip = $("strip"), days = $("days");
    strip.replaceChildren(); days.replaceChildren();
    var evs = cal.data || [], groups = {}, nextEv = evs.filter(function (e) { return !e.allDay && e.s > now; })[0];
    evs.forEach(function (ev) {
      var k = dayKey(ev.s < today ? today : ev.s);
      (groups[k] = groups[k] || []).push(ev);
    });
    for (var i = 0; i < DAYS; i++) {
      var d = addDays(today, i), k = dayKey(d), dEnd = addDays(d, 1);
      var over = evs.filter(function (e) { return e.s < dEnd && e.e > d; });
      var c = el("button", "cell" + (i === 0 ? " today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " wknd" : ""));
      c.type = "button"; c.disabled = !groups[k];
      c.setAttribute("aria-label", fDay.format(d) + ": " + (cal.data ? over.length + (over.length === 1 ? " event" : " events") : "not loaded"));
      c.append(el("span", "dw", fDw1.format(d)), el("span", "dn", String(d.getDate())));
      var marks = el("span", "marks");
      over.slice(0, 4).forEach(function (e) { marks.append(el("i", "mark" + (e.avi ? " avi" : ""))); });
      if (over.length > 4) marks.append(el("span", "more", "+" + (over.length - 4)));
      c.append(marks);
      (function (key) { c.addEventListener("click", function () { var t = document.getElementById("d-" + key); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); }); })(k);
      strip.append(c);

      if (!cal.data) continue;
      var list = (groups[k] || []).slice().sort(function (a, b) { return (b.allDay - a.allDay) || (a.s - b.s); });
      if (!list.length && i !== 0) continue;
      var g = el("div", "day" + (i === 0 ? " today" : "")); g.id = "d-" + k;
      var h = el("div", "day-head");
      h.append(el("span", "day-name", dayName(d, today) || fDow.format(d)), el("span", "day-date", fDay.format(d)));
      g.append(h);
      if (!list.length) g.append(el("p", "empty", "Nothing scheduled today."));
      list.forEach(function (ev) { g.append(eventRow(ev, now, nextEv && nextEv.key, d)); });
      days.append(g);
    }
    if (!cal.data) days.append(el("p", "empty", waitText(cal, "Schedule")));
    var left = evs.filter(function (e) { return !e.allDay && e.e > now && dayKey(e.s) === dayKey(today); }).length;
    $("schedSub").textContent = cal.data
      ? left + " left today · " + evs.length + " in the next " + DAYS + " days"
      : "Next " + DAYS + " days · Google Calendar";
  }

  function ago(when, now) {
    var ms = now - when;
    if (ms < 36e5) return Math.max(1, Math.round(ms / 60000)) + " min ago";
    if (ms < DAY_MS) return Math.floor(ms / 36e5) + " h ago";
    return fDowS.format(when);
  }
  function renderMail(now) {
    var box = $("mail"), foot = $("mailFoot"); box.replaceChildren();
    if (!mail.data) {
      box.append(el("p", "empty", waitText(mail, "Inbox")));
      $("mailSub").textContent = "Unread, last 7 days · Gmail"; foot.hidden = true; return;
    }
    var n = mail.data.length;
    $("mailSub").textContent = (mail.more ? n + "+" : String(n)) + " unread · last 7 days";
    if (!n) box.append(el("p", "empty", "No unread mail from the last 7 days. Inbox is clear."));
    mail.data.forEach(function (t) {
      var r = el("div", "ev"), tm = el("div", "ev-time");
      tm.append(el("span", "t1", ago(t.when, now)), el("span", "t2", now - t.when < DAY_MS ? fTime.format(t.when) : fDay.format(t.when).replace(/^[^,]+,\s*/, "")));
      var body = el("div", "ev-body"), from = el("div", "from");
      from.append(el("span", null, t.from));
      if (t.important) from.append(el("span", "pill p-next", "Important"));
      if (t.count > 1) from.append(el("span", "pill p-count", t.count + " messages"));
      var title = el("div", "ev-title"); title.append(titleNode(t.subject, t.link, "Open in Gmail"));
      body.append(from, title);
      r.append(tm, body); box.append(r);
    });
    foot.hidden = !mail.more;
    foot.textContent = mail.more ? "Showing the newest " + n + " threads. Open Gmail for the rest." : "";
  }

  function renderStatus() {
    var pageMsg = state.netError ? "Can't reach the dashboard server. If it was asleep it takes up to a minute to wake; the page keeps trying." : null;
    $("pageNote").hidden = !pageMsg; $("pageNote").textContent = pageMsg || "";
    [[cal, "calNote"], [mail, "mailNote"]].forEach(function (pair) {
      var s = pair[0], n = $(pair[1]);
      n.hidden = !s.error; n.textContent = s.error ? errCopy(s) : "";
    });
    var ok = slots.filter(function (s) { return s.data && !s.error; }).length, any = slots.filter(function (s) { return s.data && s.at; });
    var oldest = any.length ? Math.min.apply(null, any.map(function (s) { return s.at; })) : null;
    var live = ok === slots.length && !state.netError;
    $("dot").className = "dot" + (live ? " live" : any.length ? " stale" : "");
    $("freshText").textContent = live ? "Live · updated " + fTime.format(new Date(oldest))
      : any.length ? (state.netError ? "Offline" : "Partly live") + " · last updated " + fTime.format(new Date(oldest))
      : !state.loaded ? "Connecting…" : "Unavailable";
    var b = $("refresh"); b.disabled = state.fetching; b.textContent = state.fetching ? "Refreshing…" : "Refresh";
  }

  function clock(now) {
    $("dow").textContent = fDow.format(now); $("date").textContent = fDate.format(now);
    $("local").textContent = fClock.format(now);
    $("zulu").textContent = pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + "Z";
  }
  function keyOf(now) {
    var tail = function (s) { return "/" + (s.error ? s.error.code : "") + "/" + s.at; };
    return dayKey(now) + "#" + (cal.data || []).map(function (e) { return e.key + evState(e, now); }).join(",") + tail(cal) +
      "#" + (mail.data || []).map(function (t) { return t.key; }).join(",") + tail(mail) + "#" + Math.floor(now / 300000) + "#" + state.netError + state.fetching;
  }
  function render(force) {
    var now = new Date(), today = startOfDay(now), k = keyOf(now);
    clock(now);
    if (force || k !== state.renderKey) {
      state.renderKey = k;
      renderBand(now, today); renderSchedule(now, today); renderMail(now); renderStatus();
    } else {
      state.cds.forEach(function (c) { c.node.textContent = cdText(c.ev, now); });
    }
  }
  function tick() {
    if (document.hidden) return;
    var since = Date.now() - state.lastTry;
    if (state.day !== dayKey(new Date()) || since >= POLL || (state.netError && since >= RETRY)) load();
    render(false);
  }

  /* TV mode (?tv): larger type and ask the browser to keep the screen on. */
  var wakeLock = null;
  function keepAwake() {
    if (!TV || !navigator.wakeLock || document.hidden || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      wakeLock = l; l.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () {});
  }
  if (TV) document.documentElement.classList.add("tv");

  $("refresh").addEventListener("click", function () { load(); render(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { keepAwake(); tick(); } });
  setInterval(tick, 15000);
  render(true);
  load();
  keepAwake();
})();
