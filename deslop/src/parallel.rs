//! Work over many files spread across the machine's cores, each answer where its file stood.

use std::panic;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

/// `each` of every item, in the order of `items`, worked out on as many threads as the machine has cores: each thread
/// takes the next item left, so that one large file does not hold up a share of the others.
pub fn map<'a, T: Sync, R: Send>(items: &'a [T], each: impl Fn(&'a T) -> R + Sync) -> Vec<R> {
    // A machine that cannot say how many cores it has is worked on as one
    let cores = thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let next = AtomicUsize::new(0);
    let mut done: Vec<(usize, R)> = thread::scope(|scope| {
        let workers: Vec<_> = (0..cores.min(items.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let position = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(position) else { break };
                        done.push((position, each(item)));
                    }
                    done
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_else(|panicked| panic::resume_unwind(panicked)))
            .collect()
    });
    done.sort_unstable_by_key(|(position, _)| *position);
    done.into_iter().map(|(_, answer)| answer).collect()
}
