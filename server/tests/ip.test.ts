import { describe, expect, it } from 'vitest';
import { normalizeIp } from '../src/ip.js';

describe('normalizeIp', () => {
  it('normalizes IPv6 loopback to IPv4 loopback', () => {
    expect(normalizeIp('::1')).toBe('127.0.0.1');
  });

  it('unwraps ipv4-mapped ipv6 addresses', () => {
    expect(normalizeIp('::ffff:192.168.1.12')).toBe('192.168.1.12');
  });

  it('keeps ipv6 addresses lowercase', () => {
    expect(normalizeIp('FE80::ABCD')).toBe('fe80::abcd');
  });
});
