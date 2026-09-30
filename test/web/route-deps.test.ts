import { CONTEXT } from '../../src/core/kube/names';
import {
  bag,
  bool,
  kubeContext,
  oneDecimal,
  orText,
  strings,
  text,
} from '../../src/web/route-deps';

describe("earlier releases' JSON boundary semantics", () => {
  it('copies only own properties from request objects', () => {
    const value = Object.assign(Object.create({ inherited: 'no' }) as object, { own: 'yes' });
    expect(bag(value)).toEqual({ own: 'yes' });
  });

  it("uses earlier releases' truthiness for empty collections and preserves real booleans", () => {
    expect(bool([])).toBe(false);
    expect(bool({})).toBe(false);
    expect(bool([0])).toBe(true);
    expect(bool(false, true)).toBe(false);
  });

  it('writes the value, or the fallback for an empty one, as text for false, zero, and empty text', () => {
    expect(orText(false)).toBe('');
    expect(orText(0)).toBe('');
    expect(orText('', 'fallback')).toBe('fallback');
    expect(orText('value', 'fallback')).toBe('value');
    expect(orText(true)).toBe('True');
    expect(text(null)).toBe('None');
    expect(strings([true, null, { one: 1 }, [1]])).toEqual(['True', 'None', "{'one': 1}", '[1]']);
  });

  it("uses earlier releases' Kubernetes default and their half-even rounding", () => {
    expect(kubeContext({})).toBe(CONTEXT);
    expect(kubeContext({ context: 'named-cluster' })).toBe('named-cluster');
    expect(kubeContext({ context: true })).toBe('True');
    expect(kubeContext({ context: ['one', false] })).toBe("['one', False]");
    expect(oneDecimal(1.25)).toBe(1.2);
    expect(oneDecimal(1.35)).toBe(1.4);
  });
});
