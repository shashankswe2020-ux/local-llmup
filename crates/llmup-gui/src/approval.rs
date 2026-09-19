use llmup_runtime::{
    agent::{Decision, ToolApprover},
    harness::HarnessError,
    mcp::ReviewedCall,
};
use std::{collections::BTreeMap, sync::Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
#[derive(Default)]
pub struct Approvals {
    pending: Mutex<BTreeMap<String, Reply>>,
}
struct Reply {
    sender: Option<oneshot::Sender<Decision>>,
    receiver: Option<oneshot::Receiver<Decision>>,
}
impl Approvals {
    pub fn register(&self, id: &str) -> Result<(), HarnessError> {
        let mut pending = self.pending.lock().map_err(|_| HarnessError::Invalid)?;
        if pending.len() >= 64 || pending.contains_key(id) {
            return Err(HarnessError::Limit);
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(
            id.into(),
            Reply {
                sender: Some(sender),
                receiver: Some(receiver),
            },
        );
        Ok(())
    }
    fn take_receiver(&self, id: &str) -> Result<oneshot::Receiver<Decision>, HarnessError> {
        self.pending
            .lock()
            .map_err(|_| HarnessError::Invalid)?
            .get_mut(id)
            .and_then(|reply| reply.receiver.take())
            .ok_or(HarnessError::Cancelled)
    }
    pub fn resolve(&self, id: &str, decision: Decision) -> bool {
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.get_mut(id).and_then(|reply| reply.sender.take()))
            .is_some_and(|sender| sender.send(decision).is_ok())
    }
    pub fn clear(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}
struct Pending<'pending> {
    owner: &'pending Approvals,
    id: String,
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.owner.pending.lock() {
            pending.remove(&self.id);
        }
    }
}
#[async_trait::async_trait]
impl ToolApprover for Approvals {
    async fn decide(
        &self,
        call_id: &str,
        _: &ReviewedCall,
        cancel: &CancellationToken,
    ) -> Result<Decision, HarnessError> {
        let receiver = self.take_receiver(call_id)?;
        let _pending = Pending {
            owner: self,
            id: call_id.into(),
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err(HarnessError::Cancelled),result=receiver=>result.map_err(|_|HarnessError::Cancelled)}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn decision_can_arrive_immediately_after_publication() {
        let approvals = Approvals::default();
        approvals.register("call").unwrap();
        assert!(approvals.resolve("call", Decision::ApproveOnce));
        assert!(!approvals.resolve("call", Decision::ApproveOnce));
        let receiver = approvals.take_receiver("call").unwrap();
        assert!(matches!(receiver.await.unwrap(), Decision::ApproveOnce));
        assert!(approvals.take_receiver("call").is_err());
        assert!(!approvals.resolve("unknown", Decision::ApproveOnce));
        approvals.register("cancelled").unwrap();
        approvals.clear();
        assert!(!approvals.resolve("cancelled", Decision::ApproveOnce));
    }
}
