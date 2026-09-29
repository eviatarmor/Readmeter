use std::collections::VecDeque;

use crate::SCHEMA_VERSION;
use crate::envelope::Envelope;
use crate::finding::Finding;
use crate::wire::{Batch, SdkInfo};

#[derive(Debug, Clone, Copy)]
pub struct BufferConfig {
    pub max_events: usize,
    pub max_findings: usize,
}

impl Default for BufferConfig {
    fn default() -> Self {
        Self {
            max_events: 2_000,
            max_findings: 200,
        }
    }
}

/// Bounded in-memory queue of events and findings awaiting upload.
///
/// When full it drops the oldest entries and counts them, so memory stays
/// bounded if the host never flushes or the network is down. It never blocks.
#[derive(Debug)]
pub struct Buffer {
    config: BufferConfig,
    events: VecDeque<Envelope>,
    findings: VecDeque<Finding>,
    dropped_events: u64,
    dropped_findings: u64,
}

impl Buffer {
    pub fn new(config: BufferConfig) -> Self {
        Self {
            config,
            events: VecDeque::new(),
            findings: VecDeque::new(),
            dropped_events: 0,
            dropped_findings: 0,
        }
    }

    pub fn push_event(&mut self, event: Envelope) {
        if self.config.max_events == 0 {
            self.dropped_events += 1;
            return;
        }
        if self.events.len() >= self.config.max_events {
            self.events.pop_front();
            self.dropped_events += 1;
        }
        self.events.push_back(event);
    }

    pub fn push_finding(&mut self, finding: Finding) {
        if self.config.max_findings == 0 {
            self.dropped_findings += 1;
            return;
        }
        if self.findings.len() >= self.config.max_findings {
            self.findings.pop_front();
            self.dropped_findings += 1;
        }
        self.findings.push_back(finding);
    }

    pub fn len(&self) -> usize {
        self.events.len() + self.findings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0 && self.dropped_events == 0 && self.dropped_findings == 0
    }

    /// Takes everything buffered so far. Returns `None` when there is nothing
    /// to send.
    pub fn drain(&mut self, sdk: &SdkInfo, session: u64, now_ms: u64) -> Option<Batch> {
        if self.is_empty() {
            return None;
        }
        let batch = Batch {
            schema: SCHEMA_VERSION,
            sdk: sdk.clone(),
            session,
            sent_at_ms: now_ms,
            dropped_events: self.dropped_events,
            dropped_findings: self.dropped_findings,
            events: self.events.drain(..).collect(),
            findings: self.findings.drain(..).collect(),
        };
        self.dropped_events = 0;
        self.dropped_findings = 0;
        Some(batch)
    }
}

/// Session-level sampling. Whole sessions are kept or dropped so windowed
/// rules on the backend still see complete sequences.
#[derive(Debug, Clone, Copy)]
pub struct Sampler {
    /// Kept sessions per million.
    per_million: u64,
}

impl Sampler {
    /// `rate` is clamped to `[0, 1]`.
    pub fn new(rate: f64) -> Self {
        let rate = if rate.is_nan() {
            0.0
        } else {
            rate.clamp(0.0, 1.0)
        };
        Self {
            per_million: (rate * 1_000_000.0).round() as u64,
        }
    }

    pub fn keep(&self, session: u64) -> bool {
        splitmix64(session) % 1_000_000 < self.per_million
    }
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{CallContext, Op, Outcome, Target};
    use crate::units::Units;

    fn event(ts: u64) -> Envelope {
        Envelope {
            ts_ms: ts,
            provider: "p".into(),
            service: "s".into(),
            op: Op::Get,
            target: Target::default(),
            query: None,
            result: None,
            usage: None,
            outcome: Outcome::Ok,
            duration_us: None,
            ctx: CallContext::default(),
            units: Units::new(),
        }
    }

    fn sdk() -> SdkInfo {
        SdkInfo {
            name: "test".into(),
            version: "0".into(),
        }
    }

    #[test]
    fn drops_oldest_when_full() {
        let mut b = Buffer::new(BufferConfig {
            max_events: 2,
            max_findings: 1,
        });
        for ts in 0..5 {
            b.push_event(event(ts));
        }
        let batch = b.drain(&sdk(), 1, 10).expect("batch");
        assert_eq!(batch.dropped_events, 3);
        assert_eq!(
            batch.events.iter().map(|e| e.ts_ms).collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert!(b.drain(&sdk(), 1, 11).is_none());
    }

    #[test]
    fn sampler_bounds() {
        assert!(!Sampler::new(0.0).keep(42));
        assert!(Sampler::new(1.0).keep(42));
        assert!(Sampler::new(f64::NAN).per_million == 0);
        let kept = (0..10_000u64)
            .filter(|s| Sampler::new(0.25).keep(*s))
            .count();
        assert!((2_000..3_000).contains(&kept), "kept {kept}");
    }
}
