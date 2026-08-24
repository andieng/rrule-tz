import { describe, it, expect } from 'vitest';
import { getLocalTimeInUtc, getUtcTimeFromLocal } from '../src/timezone';

describe('getUtcTimeFromLocal', () => {
  it('converts a CET (UTC+1) floating wall-clock date to its true UTC instant', () => {
    // "09:00" mislabeled as UTC digits, representing 09:00 wall-clock time in Berlin.
    const floating = new Date('2026-02-11T09:00:00.000Z');
    expect(getUtcTimeFromLocal('Europe/Berlin', floating).toISOString()).toBe('2026-02-11T08:00:00.000Z');
  });

  it('converts a CEST (UTC+2) floating wall-clock date to its true UTC instant', () => {
    const floating = new Date('2026-07-13T07:00:00.000Z');
    expect(getUtcTimeFromLocal('Europe/Berlin', floating).toISOString()).toBe('2026-07-13T05:00:00.000Z');
  });

  it('is a no-op for the UTC timezone', () => {
    const floating = new Date('2026-07-13T07:00:00.000Z');
    expect(getUtcTimeFromLocal('UTC', floating).toISOString()).toBe(floating.toISOString());
  });
});

describe('getLocalTimeInUtc', () => {
  it('is the inverse of getUtcTimeFromLocal across a DST boundary', () => {
    // Deliberately avoids the DST fall-back fold hour (2026-10-25 01:00-02:00 CEST/CET in
    // Berlin), where the local wall-clock time is inherently ambiguous and round-tripping
    // through a floating representation cannot be lossless for any timezone library.
    const instants = ['2026-02-11T08:00:00.000Z', '2026-07-13T05:00:00.000Z', '2026-10-24T20:00:00.000Z'];

    instants.forEach(iso => {
      const original = new Date(iso);
      const floating = getLocalTimeInUtc('Europe/Berlin', original);
      expect(getUtcTimeFromLocal('Europe/Berlin', floating).toISOString()).toBe(original.toISOString());
    });
  });
});
