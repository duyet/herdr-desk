/**
 * A fixture, not a poller.
 *
 * `examples/watch-events` exists so the config beside it can be copied, so this
 * script prints one fixed event and exits. The event is a constant rather than
 * the result of a query because there is nothing here to query: a real watcher
 * does what `docs/watch.md` shows — call an API, keep its own cursor, print
 * whatever it has not been told about yet.
 *
 * What it is here for is the shape of the output: one JSON object per line on
 * stdout, with an `id` that is stable across polls. That `id` is the dedupe key,
 * which is why this one never re-fires after the first poll.
 *
 * The fixed id is also why this is honest as an example. A script that printed
 * a *new* id on every poll would be a fixture that behaves like a chatty
 * production watcher and would fill the queue in a demo.
 */
console.log(
  JSON.stringify({
    id: 'example-event-1',
    type: 'example.fixed',
    at: '2026-10-05T00:00:00Z',
    summary: 'a fixed event, printed once per poll and deduped after the first',
  }),
)
