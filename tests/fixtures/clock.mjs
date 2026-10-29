/* A steady clock for the test processes.
   Several tests compare a value the Worker stamped ("today", this month's period, this hour's
   counter key) with the same value computed a moment later in the test. A run that crosses an
   hour, day or month boundary between the two would fail through no fault of the code, which is
   the classic flaky test. Each test file imports this first: time still flows at the normal rate,
   but every process starts at 12:20:00 UTC on the 15th of the current month, so a run (seconds
   long) cannot cross any of those boundaries. Date.parse, Date.UTC and explicit constructors are
   untouched; only "now" is shifted. */
const RealDate = Date;
const startReal = RealDate.now();
const anchor = new RealDate(startReal);
anchor.setUTCDate(15);
anchor.setUTCHours(12, 20, 0, 0);
const offset = anchor.getTime() - startReal;

class SteadyDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = SteadyDate;
export const CLOCK_OFFSET_MS = offset;
