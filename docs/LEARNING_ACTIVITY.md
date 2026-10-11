# Learning activity and streak policy

The dashboard graph is named **Learning Activity**. It shows events stored for the signed-in user in the backend database. It does not report GitHub contribution data.

## Events counted

One event is counted when a user:

- Marks a DSA problem solved. Repeating the request while it remains solved does not add another event. Reopening the problem removes that solve event; solving it later records a new event.
- Marks a problem revised. The same problem contributes at most once per calendar day.
- Creates a personal note on a problem. Editing an existing note does not add another event.
- Logs a study session. Its submitted minutes contribute to study-time totals.
- Answers an aptitude practice question for the first time. Re-answering the same question does not create another practice event.
- Completes a roadmap topic or section. Repeated completion requests do not add events; reopening a completed item removes the corresponding completion activity.
- Posts an interview-experience comment. New comment events are linked to the comment; deleting one removes its linked event and recalculates the affected day.

The graph's daily number is the count of qualifying events on that date. Its intensity bands are 0 events (neutral), 1 (light), 2–3 (medium), 4–6 (strong), and 7 or more (highest).

## Events not counted

Sign-in, sign-out, page views, refreshes, opening external links, bookmarks, revision flags, hint reveals, likes, payment activity, content unlocks, and puzzle-game practice are excluded. In particular, opening a LeetCode link does not prove that the problem was solved; the user must explicitly mark it solved.

## Calendar and streak rules

The backend uses `APP_TIMEZONE` (production should keep `Asia/Kolkata`) and stores each event against the app-local calendar date, represented as UTC midnight. The graph never counts future dates. Missing days have zero activity.

A streak day is any calendar day with one or more qualifying events. More events on the same day do not add streak days. A first active day starts a one-day streak; consecutive active dates extend it. If today has no activity, the current streak remains active through yesterday and is zero after a missed day. Longest streak is derived from the persisted event dates, so corrections or removed events reconcile both values.
