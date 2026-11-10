---
title: "A shared post is one feed update"
description: "The signed-in page reads one activity with the feed updates request. The card uses three fields."
status: current
date: 2026-11-10
---

# A shared post is one feed update

Captured 2026-11-10 inside the plugin's signed-in page. No cookie is stored here.

The request is `GET /voyager/api/feed/updates/` plus the encoded `urn:li:activity:` id, with the same csrf header and accept header as the inbox read. It answers `{ data, included }`. The update is the included entity whose type is `com.linkedin.voyager.feed.render.UpdateV2`.

The card reads three fields:

- Words: `commentary.text.text`
- Author: `actor.name.text`
- Picture: `content.images[0].attributes[0].vectorImage`, joined as `rootUrl` plus the last artifact's `fileIdentifyingUrlPathSegment`

The picture host on that capture was `media.licdn.com`. The author's own face is a different image and is not the post picture. A commentary can be longer than the card keeps. The page read keeps the first 300 characters.
