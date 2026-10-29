# Messages read-only integration handoff

## Current state

The Messages implementation is in this feature worktree, not the installed plugin. It reads local Messages using `imsg` and keeps every Messages mutation disabled server-side. PNG, JPEG, GIF and WebP images up to 6 MiB are loaded on demand after verifying that the attachment belongs to a freshly fetched conversation and resolves under the Messages attachment directory. Other attachments remain placeholders. Cache data is sensitive and unencrypted. Full reply threading and edit history are not available.

A temporary isolated preview previously showed the conversation list and history in BB. The image path was subsequently verified through the actual plugin RPC in a fake host using the local Messages database, not in a live BB UI. Before deployment, verify image rendering in a safe staging environment and review the existing plugin's security and cache behavior.

## Integration preflight (2026-10-29)

The installed plugin is registered from the separate personal workspace. It has uncommitted changes and a different Git history from this worktree. Do not copy this worktree over it, reset it, install it from that path, or rebuild its `dist/` as part of staging. A read-only three-way check using this worktree's `HEAD` as the base and the installed workspace's current files as the other side reported conflicts in `app.tsx`, `server.ts`, and `src/inbox-cache.ts`. These results are point-in-time; repeat them against a fresh snapshot before integration. New files had no destination collisions at the time of the check.

## Safe preparation and deployment

1. With the owner's approval, snapshot the installed workspace's source, untracked files, `dist/`, and plugin registration without modifying them. Account for concurrent edits; abort if the snapshot changes while being captured. Do not include credentials in portable artifacts.
2. Assemble a separate staging directory from that snapshot. Merge each feature change against its feature-base version, resolving conflicts in the staging directory while preserving both the existing search work and the Messages work. Review the complete resulting diff against the snapshot, including generated artifacts and untracked files. Never apply a blind patch over the installed workspace.
3. Run all tests, type-check, and build in staging. Verify local read access, failure isolation, all blocked Messages mutation RPCs, cache behavior, attachment path containment, and live UI behavior without sending. Verify the snapshot and original registration remain unchanged after staging.
4. Before changing the active plugin, establish and test a rollback that restores the original registration **without rebuilding or altering its original workspace or `dist/`**. A path reinstall may rebuild, so it is not a verified rollback. If no supported safe rollback can be demonstrated, stop and ask the owner before any deployment. Review the plugin database compatibility and backup/rollback implications as well.
5. Only after explicit deployment approval, activate the reviewed artifact using the verified switch and rollback procedure. Recheck the source registration, read-only behavior and original workspace; do not send a test message.
