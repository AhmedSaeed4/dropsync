import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';
import {
  CALL_LIMIT_MESSAGE,
  CALL_TOTAL_MINUTES,
  PENDING_CALL_GRACE_MS,
  authUid,
  cascadeCallSubcollectionsIfGeneration,
  enforceExpiredCall,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getTrustedStatusMapInTransaction,
  isPendingCallStale,
  releaseReservationWrite,
  reserveCallUsageInTransaction,
  refreshCallLimitState,
} from '../_lib';

// Mirror /api/transcribe: Node runtime, 30s headroom under Vercel's timeout, always dynamic. The
// added Firestore transaction (one-call-per-workspace) needs the headroom.
export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/start  — body { workspaceId }. The SOLE creator of a call drop (NEVER client-side;
// firestore.rules block client create of type 'call'). Enforces ONE-CALL-PER-WORKSPACE via a single
// transaction on the DETERMINISTIC doc id `drops/call-{workspaceId}`.
//
// LIFECYCLE (pending → confirmed → live): the doc is created as `callState: 'pending'` — INVISIBLE
// to other members (the drop listener only shows 'live') and NEVER charged. The host then connects
// to the generation-unique LiveKit room and POSTs /api/call/confirm; only that promotion makes the
// call live and starts the clock. If the host's browser dies in between (tab-close ghost call), no
// member ever sees the call, the reservation is released with zero charge (lazy release on the next
// start attempt), and the daily cron sweep deletes the stale pending doc + room.
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = getAdminDb();

    // (1) Re-derive membership server-side. 403 if the caller isn't a member (NEVER trust a body uid).
    const wsSnap = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsSnap.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 403 });
    }
    const members: unknown = wsSnap.data()?.members;
    if (!Array.isArray(members) || !members.includes(uid)) {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
    }

    // Host display name (creatorName) — profiles/{uid}.displayName, else users/{uid}.email prefix.
    // Display-only: the drop card resolves the host name from workspaceMembers by callHostUid.
    let hostDisplayName = 'Host';
    try {
      const prof = await db.collection('profiles').doc(uid).get();
      const profName = prof.exists ? prof.data()?.displayName : null;
      if (typeof profName === 'string' && profName.trim()) {
        hostDisplayName = profName.trim();
      } else {
        const u = await db.collection('users').doc(uid).get();
        const email = u.exists ? u.data()?.email : null;
        if (typeof email === 'string' && email.includes('@')) hostDisplayName = email.split('@')[0];
      }
    } catch {
      /* best-effort — fall back to 'Host' */
    }

    // (2) ONE transaction on the deterministic id. The create is INSIDE the txn so the one-call-
    // per-workspace invariant is atomic. set() overwrites a stale/dead call in the slot (no
    // delete+set conflict); the subcollection leftovers from that stale call are cascaded after.
    const callDocId = `call-${workspaceId}`;
    const callRef = db.collection('drops').doc(callDocId);
    const nowMs = Date.now();

    // Avoid creating a second LiveKit room when this request is simply joining an already-live call.
    // New calls explicitly create the room here so its server-issued SID can be bound to the call doc;
    // the webhook uses that binding to reject delayed events from an older call in this reused slot.
    const currentSnap = await callRef.get();
    if (currentSnap.exists) {
      const currentData = currentSnap.data() as {
        callState?: string;
        callHostUid?: unknown;
        livekitRoomName?: unknown;
      };
      if (currentData.callState === 'live') {
        const limitState = await refreshCallLimitState(db, callDocId, nowMs);
        if (limitState.expired) {
          const enforcement = await enforceExpiredCall(db, callDocId, nowMs);
          if (!enforcement.ended) {
            const currentAfterEnforcement = await callRef.get();
            if (currentAfterEnforcement.data()?.callState === 'live') {
              return NextResponse.json({
                callDropId: callDocId,
                callState: 'live',
                livekitRoomName:
                  typeof currentAfterEnforcement.data()?.livekitRoomName === 'string'
                    ? currentAfterEnforcement.data()?.livekitRoomName
                    : undefined,
              });
            }
          }
        } else {
          return NextResponse.json({
            callDropId: callDocId,
            callState: 'live',
            livekitRoomName:
              typeof currentData.livekitRoomName === 'string' ? currentData.livekitRoomName : undefined,
          });
        }
      }
      if (currentData.callState === 'pending') {
        const fresh = !isPendingCallStale(currentSnap.data(), nowMs);
        if (fresh && currentData.callHostUid !== uid) {
          return NextResponse.json(
            { error: 'Someone is already starting a call in this workspace. Try again in a moment.', callDropId: callDocId },
            { status: 409 },
          );
        }
        // Fresh same-host pending: the previous tab may have died before confirm, so replace its
        // generation instead of returning a tokenless pendingSelf response.
        // Stale pending → falls through; the txn overwrites it (and re-uses the host's reservation).
      }
    }

    const roomService = getLiveKitRoomService();
    if (!roomService) {
      console.error('call/start: LiveKit room service is not configured');
      return NextResponse.json({ error: 'LiveKit is not configured' }, { status: 500 });
    }

    // Generation-unique LiveKit room name (a delayed webhook for an OLD room can never resolve to
    // the NEW call — the doc lookup keys on livekitRoomName, and the SID guard is a second gate).
    // The Firestore doc id stays deterministic (`call-{workspaceId}`): one call per workspace.
    const roomName = `call-${workspaceId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let livekitRoomSid: string;
    try {
      const room = await roomService.createRoom({ name: roomName });
      if (!room.sid) throw new Error('LiveKit returned no room SID');
      livekitRoomSid = room.sid;
    } catch (err) {
      console.error('call/start room creation failed:', err);
      try {
        const current = await callRef.get();
        const currentRoomName = typeof current.data()?.livekitRoomName === 'string' ? current.data()?.livekitRoomName : null;
        if (current.data()?.callState !== 'live' && currentRoomName !== roomName) await roomService.deleteRoom(roomName);
      } catch (cleanupError) {
        console.warn('call/start room-creation cleanup failed:', cleanupError);
      }
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    // The room we created in THIS request is ours to delete whenever we did not win the slot (a
    // concurrent starter committed first, or the txn failed). Unique names mean createRoom never
    // returns a pre-existing room, so every non-winning path must clean up explicitly.
    const cleanupCreatedRoom = async () => {
      const current = await callRef.get();
      const currentData = current.data();
      if (currentData?.livekitRoomName === roomName) return; // we won — keep the room
      if (currentData?.callState === 'live' && currentData.livekitRoomName == null) return; // legacy live call — never touch
      await roomService.deleteRoom(roomName);
    };

    let decision:
      | { kind: 'created'; attemptToken: string; orphanedReservationCallId: string | null; staleRoomName: string | null }
      | { kind: 'existing' }
      | { kind: 'busy' }
      | { kind: 'limited'; resetAtMs: number };
    try {
      decision = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        let staleHostUid: string | null = null;
        let staleRoomName: string | null = null;
        if (snap.exists) {
          const data = snap.data() as {
            callState?: string;
            callHostUid?: unknown;
            callPendingAt?: unknown;
            createdAt?: unknown;
            livekitRoomName?: unknown;
          };
          if (data.callState === 'live') {
            return { kind: 'existing' as const };
          }
          if (data.callState === 'pending') {
            const fresh = !isPendingCallStale(snap.data(), nowMs);
            if (fresh) {
              if (data.callHostUid !== uid) return { kind: 'busy' as const };
              // Same-host reclaim replaces the fresh generation. Capture its room so the
              // post-commit cleanup closes the room abandoned by the previous tab.
              staleHostUid = typeof data.callHostUid === 'string' ? data.callHostUid : null;
              staleRoomName = typeof data.livekitRoomName === 'string' ? data.livekitRoomName : null;
            }
            if (!fresh) {
              // Stale pending in the slot → replace it wholesale below. Its reservation (if held by a
              // DIFFERENT member) and its generation-unique room must be cleaned up so the previous
              // host is never blocked by the reused slot and the room never leaks.
              staleHostUid = typeof data.callHostUid === 'string' ? data.callHostUid : null;
              staleRoomName = typeof data.livekitRoomName === 'string' ? data.livekitRoomName : null;
            }
          }
        }
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, [uid]);
        const trustedForCall = trustedByUid.get(uid) === true;
        const usageStates = await getCallUsageStatesInTransaction(txn, db, [uid], nowMs);
        let usage = usageStates.get(uid);
        // ---- READ PHASE (Firestore transactions require all reads before all writes) ----
        // LAZY RELEASE (load-bearing): a reservation for a NEVER-CONFIRMED call elsewhere must never
        // block this start. Cleared with zero charge via the RAW read (fresh OR stale — a stale
        // pending's id is normalized away, but the persisted reservation must still be cleared so it
        // never resurrects when that slot is reused). The orphaned pending doc is then cleaned
        // best-effort outside the txn. minutesUsedToday is untouched — never-joined time is never
        // billed.
        let orphanedReservationCallId: string | null = null;
        const rawUsageSnap = await txn.get(db.collection('callUsage').doc(uid));
        const rawReservedCallId =
          typeof rawUsageSnap.data()?.reservedCallId === 'string'
            ? (rawUsageSnap.data()?.reservedCallId as string)
            : null;
        let orphanReservationIsReleasable = false;
        if (rawReservedCallId && rawReservedCallId !== callDocId) {
          const resSnap = await txn.get(db.collection('drops').doc(rawReservedCallId));
          // Only a NEVER-CONFIRMED reservation is released — a LIVE call's reservation (the user is
          // already in another call) must keep blocking this start. A MISSING referenced doc (the
          // pending was already swept) is also an orphan: clear it.
          orphanReservationIsReleasable =
            !resSnap.exists ||
            (resSnap.data()?.type === 'call' && resSnap.data()?.callState === 'pending');
        }
        // Replacing a stale pending started by ANOTHER member: their reservation must be released so
        // they are never blocked by the reused slot. The SAME member re-starting keeps theirs
        // (reserveCallUsageInTransaction's same-id branch carries it forward).
        let staleHostUsageRawReservedCallId: string | null = null;
        if (staleHostUid && staleHostUid !== uid) {
          const staleHostUsageSnap = await txn.get(db.collection('callUsage').doc(staleHostUid));
          staleHostUsageRawReservedCallId =
            typeof staleHostUsageSnap.data()?.reservedCallId === 'string'
              ? (staleHostUsageSnap.data()?.reservedCallId as string)
              : null;
        }
        // ---- WRITE PHASE ----
        if (orphanReservationIsReleasable) {
          releaseReservationWrite(txn, db, uid);
          orphanedReservationCallId = rawReservedCallId;
          if (usage) {
            usageStates.set(uid, {
              ...usage,
              limited: usage.minutesRemaining <= 0,
              reservedCallId: null,
              minutesReservedToday: 0,
            });
            usage = usageStates.get(uid);
          }
        }
        if (staleHostUsageRawReservedCallId === callDocId) {
          releaseReservationWrite(txn, db, staleHostUid as string);
        }
        const remainingMinutes = trustedForCall
          ? CALL_TOTAL_MINUTES
          : usage
            ? reserveCallUsageInTransaction(txn, db, uid, callDocId, usage, nowMs)
            : null;
        if (!trustedForCall && remainingMinutes == null) {
          return { kind: 'limited' as const, resetAtMs: usage?.resetAtMs ?? nowMs };
        }
        const attemptToken = randomUUID();
        txn.set(callRef, {
          type: 'call',
          userId: uid,
          name: 'Live call',
          creatorName: hostDisplayName,
          callHostUid: uid,
          callParticipantUids: [uid],
          callParticipantHistoryUids: [uid],
          callTrustedReliefUids: [],
          workspaceId,
          callState: 'pending',
          callPendingAt: FieldValue.serverTimestamp(),
          callPendingExpiresAt: Timestamp.fromMillis(nowMs + PENDING_CALL_GRACE_MS),
          callPendingAttemptHash: createHash('sha256').update(attemptToken).digest('hex'),
          livekitRoomName: roomName,
          livekitRoomSid,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: null,
          expirationOption: 'forever',
          // No callStartedAt / callLimitDeadlineAt yet — the clock starts at confirm.
          trustedParticipantCount: trustedForCall ? 1 : 0,
        });
        return { kind: 'created' as const, attemptToken, orphanedReservationCallId, staleRoomName };
      });
    } catch (err) {
      console.error('call/start transaction failed:', err);
      try {
        await cleanupCreatedRoom();
      } catch (cleanupError) {
        console.warn('call/start failed-room cleanup failed:', cleanupError);
      }
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    if (decision.kind === 'limited') {
      try {
        await cleanupCreatedRoom();
      } catch (cleanupError) {
        console.warn('call/start limited-room cleanup failed:', cleanupError);
      }
      return NextResponse.json(
        { error: CALL_LIMIT_MESSAGE, resetAt: decision.resetAtMs },
        { status: 429 },
      );
    }

    if (decision.kind === 'existing' || decision.kind === 'busy') {
      // We lost the slot claim — our room was never bound to the doc; delete it so it can't leak.
      await roomService.deleteRoom(roomName).catch((cleanupError) => {
        console.warn('call/start lost-claim room cleanup skipped:', cleanupError);
      });
    }

    if (decision.kind === 'busy') {
      return NextResponse.json(
        { error: 'Someone is already starting a call in this workspace. Try again in a moment.', callDropId: callDocId },
        { status: 409 },
      );
    }
    if (decision.kind === 'created') {
      // We (re)created the pending call. Cascade clears any subcollection leftovers from a replaced
      // stale call (the new call has none yet, so this is a no-op for a clean create). Best-effort.
      cascadeCallSubcollectionsIfGeneration(db, callDocId, roomName).catch(() => {});
      // Close the replaced stale generation's LiveKit room (unique name — never referenced again).
      if (decision.staleRoomName && decision.staleRoomName !== roomName) {
        roomService.deleteRoom(decision.staleRoomName).catch((cleanupError) => {
          console.warn('call/start stale-room cleanup skipped:', cleanupError);
        });
      }
      // Clean up an orphaned pending call from a previous never-confirmed start (lazy-release
      // counterpart): delete its doc + room. Best-effort — the daily sweep is the backstop. The
      // delete is transactionally guarded, and the cascade + room delete ONLY run when the guard
      // actually deleted the doc — a concurrent promotion or replacement aborts the whole cleanup
      // so an active call is never touched.
      if (decision.orphanedReservationCallId) {
        const orphanedId = decision.orphanedReservationCallId;
        void (async () => {
          try {
            const orphanRef = db.collection('drops').doc(orphanedId);
            const orphanSnap = await orphanRef.get();
            if (!orphanSnap.exists || orphanSnap.data()?.callState !== 'pending') return;
            const orphanRoom = typeof orphanSnap.data()?.livekitRoomName === 'string' ? orphanSnap.data()?.livekitRoomName : orphanedId;
            const deleted = await db
              .runTransaction(async (txn) => {
                const s = await txn.get(orphanRef);
                if (!s.exists || s.data()?.callState !== 'pending' || s.data()?.livekitRoomName !== orphanRoom) return false;
                txn.delete(orphanRef);
                return true;
              })
              .catch(() => false);
            if (!deleted) return; // promoted or replaced meanwhile — leave it to the sweep
            await cascadeCallSubcollectionsIfGeneration(db, orphanedId, orphanRoom).catch(() => {});
            if (roomService) await roomService.deleteRoom(orphanRoom).catch(() => {});
          } catch {
            /* best-effort — the daily sweep covers any missed orphan */
          }
        })();
      }
    }

    // The existing-live case carries the current generation's room name so the client can pass the
    // generation credential on its join cleanup (see handleStartCall → joinCall expectedRoomName).
    // Metadata for an existing call comes from the DOC (its real host/creator/roster), not from the
    // requesting user.
    let existingRoomName: string | undefined;
    let existingMetadata: {
      callHostUid?: string;
      creatorName?: string;
      callParticipantUids?: string[];
    } = {};
    if (decision.kind === 'existing') {
      const existingSnap = await callRef.get();
      const existingData = existingSnap.data();
      const existingRoom = existingData?.livekitRoomName;
      existingRoomName = typeof existingRoom === 'string' ? existingRoom : undefined;
      const existingHost = existingData?.callHostUid;
      const existingCreator = existingData?.creatorName;
      const existingParticipants = existingData?.callParticipantUids;
      existingMetadata = {
        callHostUid: typeof existingHost === 'string' ? existingHost : undefined,
        creatorName: typeof existingCreator === 'string' ? existingCreator : undefined,
        callParticipantUids: Array.isArray(existingParticipants)
          ? existingParticipants.filter((value): value is string => typeof value === 'string')
          : undefined,
      };
    }
    return NextResponse.json({
      callDropId: callDocId,
      created: decision.kind === 'created',
      callState: decision.kind === 'existing' ? 'live' : 'pending',
      attemptToken: decision.kind === 'created' ? decision.attemptToken : null,
      livekitRoomName: decision.kind === 'existing' ? existingRoomName : roomName,
      callHostUid: decision.kind === 'existing' ? existingMetadata.callHostUid : uid,
      creatorName: decision.kind === 'existing' ? existingMetadata.creatorName : hostDisplayName,
      callParticipantUids:
        decision.kind === 'existing' ? existingMetadata.callParticipantUids : [uid],
    });
  } catch (error) {
    console.error('call/start error:', error);
    return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
  }
}
