import { useMemo, useState } from 'react';
import type { ExpirationOption } from '@/types';
import {
  getExpirationDate,
  reminderOffsetMs,
  type ReminderPreset,
  type ReminderUnit,
} from '@/lib/drops';

// The four reminder presets shared by both TextModals (the reminder picker). 'custom' is a 5th
// picker state (not a fixed offset) handled inline by the UI; it switches the picker to the
// number+unit inputs. Exported so both consumers render the same fixed presets in the same order.
export const REMINDER_PRESETS: ReminderPreset[] = ['15m', '30m', '1h', '2h'];

export interface ReminderApi {
  reminderEnabled: boolean;
  reminderPreset: ReminderPreset;
  reminderCustomValue: string;
  reminderCustomUnit: ReminderUnit;
  setReminderEnabled: (v: boolean) => void;
  setReminderPreset: (v: ReminderPreset) => void;
  setReminderCustomValue: (v: string) => void;
  setReminderCustomUnit: (v: ReminderUnit) => void;
  // The Date to persist on the drop doc, or null when the reminder is OFF or the chosen time is
  // invalid (callers must NOT write reminderAt while reminderInvalid is true — block create instead).
  reminderAt: Date | null;
  // True ONLY while the reminder is ON and the chosen time is invalid. Drives the create-disable +
  // inline warning. False when off (off is always valid → no reminder written).
  reminderInvalid: boolean;
  // Short human reason when invalid (shown inline), else null.
  warning: string | null;
  // Whether the preset picker should show its selection. In EDIT mode with an existing reminder and
  // no new pick yet, the preview reflects the SAVED time (truth-on-open) and the picker stays neutral
  // so it never lies about "what's selected"; picking activates it. CREATE mode is always active.
  pickerActive: boolean;
  // EDIT-mode only (undefined initialReminderAt = CREATE → always false). True when saving now would
  // change the drop's reminder — drives the main Save gate so a reminder-only edit enables Save.
  reminderDirty: boolean;
}

/**
 * In-app reminder state for the two TextModals (TextModal + EditorialTextModal), used in BOTH
 * create and edit modes. Centralizes the preset↔offset math (reminderOffsetMs) + the live validation
 * (offset > 0 AND, unless the drop is forever, the reminder lands before the drop's own expiry) so
 * the two consumers can't drift on the math. The picker UI is rendered per-modal to match each
 * layout's own pill styling (classic vs editorial). (The DropZones never call this — they thread
 * `reminderAt` passively through TextModal's `onSubmit`.)
 *
 * `expirationOption` is the modal's chosen expiry. It's a stable string, so the validation useMemo
 * only recomputes when it (or a reminder field) actually changes — not every render.
 *
 * EDIT-mode callers pass `maxDate` = the drop's CONCRETE expiry (or null for forever, or a fresh
 * getExpirationDate when the expiry option was just changed) so the cap reflects real remaining
 * lifetime, NOT now+option (a drop already partly elapsed has less lifetime than a freshly-created
 * one). Create mode omits it (undefined) and the cap is derived from the option. EDIT-mode callers
 * also pass `initialReminderAt` = the drop's current reminder (truth-on-open baseline + dirty check).
 */
export function useReminder(
  expirationOption: ExpirationOption,
  maxDate?: Date | null,
  initialReminderAt?: Date | null
): ReminderApi {
  // Truth-on-open: the toggle starts ON iff this drop already has a reminder. CREATE callers omit
  // initialReminderAt (undefined) → starts OFF. The modal is re-mounted per drop, so a lazy initial
  // value is correct (same pattern as the other editDrop-seeded useState calls).
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(!!initialReminderAt);
  const [reminderPreset, setReminderPresetRaw] = useState<ReminderPreset>('15m');
  const [reminderCustomValue, setReminderCustomValueRaw] = useState('');
  const [reminderCustomUnit, setReminderCustomUnitRaw] = useState<ReminderUnit>('minutes');
  // Has the user actively chosen a reminder time since open? Until they do (and an existing reminder
  // is present) the preview holds the SAVED time (truth-on-open). Sticky — toggling on/off doesn't
  // reset it, so flipping OFF→ON restores the user's in-progress selection.
  const [reminderSelected, setReminderSelected] = useState(false);
  // The instant the user last picked a preset/custom value/unit (a fresh Date each pick). The compute
  // branch builds the fire time off THIS, not off memo-eval now, so (a) the fire time pins to the
  // pick instant (no drift if the memo recomputes for an unrelated reason) and (b) re-clicking the
  // ALREADY-active preset still changes this Date → the memo recomputes and re-arms (React would
  // otherwise bail on the unchanged preset value and skip the recompute). null until the first pick.
  const [reminderArmedAt, setReminderArmedAt] = useState<Date | null>(null);

  // Picking any preset / custom value / unit counts as a NEW selection (activates the picker and
  // recomputes the preview against pick-time+offset instead of the saved time) AND re-arms (fresh
  // reminderArmedAt). Toggling on/off does neither.
  const setReminderPreset = (v: ReminderPreset) => { setReminderPresetRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };
  const setReminderCustomValue = (v: string) => { setReminderCustomValueRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };
  const setReminderCustomUnit = (v: ReminderUnit) => { setReminderCustomUnitRaw(v); setReminderSelected(true); setReminderArmedAt(new Date()); };

  // The picker reflects a selection once the user has made one, OR when there's no existing reminder
  // to be "truthful" about (CREATE mode, or EDITing a drop that has no reminder yet).
  const pickerActive = reminderSelected || !initialReminderAt;

  const { reminderAt, reminderInvalid, warning } = useMemo(() => {
    if (!reminderEnabled) return { reminderAt: null, reminderInvalid: false, warning: null };
    // Truth-on-open: until the user picks a NEW time, the preview (and what would persist) is the
    // drop's existing reminder. Re-validate it against the live clock + expiry cap — a stale saved
    // time may have drifted into the past or past a newly-changed expiry.
    if (!reminderSelected && initialReminderAt) {
      // The SAVED reminder IS the drop's current state — it is never "blocking-invalid" on open (only
      // a NEW selection can be), so reminderInvalid stays false and Save isn't blocked for an unrelated
      // content edit. A content-only save writes nothing here (reminderDirty is false: reminderAt ===
      // initialReminderAt). The "has fired" advisory is rendered by the COMPONENT (live, off the
      // ticking reminderFire.fired) so it also appears when a reminder fires WHILE the modal is open —
      // this memo deliberately has no `now` dep (adding one would drift a selected fire time forward
      // each tick). The past-expiry advisory stays here: it's a static relationship the component's
      // `fired` flag can't derive (a future reminder past the expiry hasn't "fired").
      const now = new Date();
      if (initialReminderAt.getTime() <= now.getTime()) {
        return { reminderAt: initialReminderAt, reminderInvalid: false, warning: null };
      }
      if (maxDate !== undefined && maxDate && initialReminderAt.getTime() > maxDate.getTime()) {
        return { reminderAt: initialReminderAt, reminderInvalid: false, warning: 'This reminder is past the expiry — pick a new time or turn it off.' };
      }
      return { reminderAt: initialReminderAt, reminderInvalid: false, warning: null };
    }
    // New selection (or no existing reminder) → compute (pick-time) + offset. `reminderArmedAt` is
    // the instant of the last pick (a fresh Date each time, so re-clicking the active preset re-arms);
    // it pins the fire time to the pick instant. null only before the first pick → fall back to now.
    // new Date() (not Date.now()) — the react-compiler flags the Date.now method as an impure read
    // during render; the constructor doesn't.
    const offset = reminderOffsetMs(reminderPreset, reminderCustomValue, reminderCustomUnit);
    const baseNow = reminderArmedAt ?? new Date();
    const at = new Date(baseNow.getTime() + offset);
    if (offset <= 0) {
      return { reminderAt: null, reminderInvalid: true, warning: 'Enter a reminder time in the future.' };
    }
    // Cap the reminder at the drop's own expiry (a reminder after the drop is gone is pointless).
    // `maxDate` (EDIT mode) is the drop's CONCRETE expiry — a drop already partly elapsed has less
    // remaining lifetime than now+option, so deriving from the option would overestimate it. When
    // `maxDate` is undefined (CREATE mode) the cap is derived from the option; null = no cap (forever).
    const cap: Date | null = maxDate !== undefined
      ? maxDate
      : (expirationOption !== 'forever' ? getExpirationDate(expirationOption) : null);
    if (cap && at.getTime() > cap.getTime()) {
      return { reminderAt: null, reminderInvalid: true, warning: 'Reminder must be before the drop expires.' };
    }
    return { reminderAt: at, reminderInvalid: false, warning: null };
  }, [reminderEnabled, reminderSelected, initialReminderAt, reminderPreset, reminderCustomValue, reminderCustomUnit, maxDate, expirationOption, reminderArmedAt]);

  // Dirty vs the drop's current reminder — drives the EDIT-mode main-Save gate (a reminder-only edit
  // must enable Save). Compares "what would persist" (the preview time when ON+valid, else null) to
  // the initial reminder. CREATE mode (initialReminderAt undefined) → always false.
  const reminderDirty =
    initialReminderAt !== undefined &&
    ((reminderEnabled && !reminderInvalid ? reminderAt?.getTime() ?? null : null) !==
      (initialReminderAt?.getTime() ?? null));

  return {
    reminderEnabled,
    reminderPreset,
    reminderCustomValue,
    reminderCustomUnit,
    setReminderEnabled,
    setReminderPreset,
    setReminderCustomValue,
    setReminderCustomUnit,
    reminderAt,
    reminderInvalid,
    warning,
    pickerActive,
    reminderDirty,
  };
}
