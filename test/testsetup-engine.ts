/**
 * `dockerAvailable()` answers yes and `composeVersion()` answers 2.29.0, on any machine.
 *
 * This is not a convenience: it is what makes the suite's result the same with and without a
 * docker binary, which is the property the project claims. Earlier releases' suite once lacked it by
 * twenty-two tests across six files -- measured by running the suite through a PATH with every
 * executable except `docker` -- after an external review saw a red gate where this box saw
 * green, purely because that box had no Docker.
 *
 * MEASURED HERE TOO, before this file existed: on a PATH without `docker`,
 * `test/core/invariants/locking.test.ts` ("takes the workspace lock on the way") and
 * `test/core/invariants/backup-and-perf.test.ts` ("says it moves Rocket.Chat only") failed
 * with `Docker isn't running`, because both drive the real preflight and the preflight
 * asked the real daemon. CLAUDE.md's "Nothing in the suite needs Docker" was false of the
 * TypeScript suite in the same way it had been false of earlier releases' one.
 *
 * TWO SEAMS, because the preflight probes two things: the daemon (`docker info`) and the
 * compose plugin (`docker compose version --short`). Stubbing only the first leaves the
 * second answering whatever this machine has installed. Every production consumer reads
 * both through `core/runner/host`, which is what this replaces. The factory is
 * `healthyHost()` in `test/testsetup-policy.ts`.
 *
 * ## What it does not do, and why that is the interesting half
 *
 * It does not stub the docker INVOCATION seams. `test/testsetup-cloud.ts` reports `docker` as
 * unavailable at the process seam underneath, so a test that reaches a real invocation gets a
 * non-zero result rather than launching anything. That division is deliberate: one says the engine
 * is HEALTHY, the other says the binary is UNREACHABLE, and together they make the suite's answer
 * independent of the box.
 *
 * ## A test that wants the engine DOWN, or the real functions, still wins
 *
 * A test that needs `dockerAvailable()` false mocks `core/runner/host` itself; that
 * registration comes after this file's and replaces it. A test whose SUBJECT is one of these
 * two functions -- `test/core/runner/host.test.ts` tests what `composeVersion` asks -- opts
 * out with `jest.unmock` of `src/core/runner/host` and says why: a fixture that replaces the
 * function under test makes the test about the fixture.
 */
import type * as PolicyNS from './testsetup-policy';

jest.mock('../src/core/runner/host', () =>
  (require('./testsetup-policy') as typeof PolicyNS).healthyHost(),
);
