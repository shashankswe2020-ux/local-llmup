use crate::sessions::SessionError;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

struct ActiveRun {
    id: String,
    token: CancellationToken,
}
#[derive(Default)]
pub struct RunCoordinator {
    active: Arc<Mutex<BTreeMap<String, ActiveRun>>>,
}
pub struct RunLease {
    active: Arc<Mutex<BTreeMap<String, ActiveRun>>>,
    session: String,
    id: String,
    token: CancellationToken,
}
impl RunCoordinator {
    pub fn begin(
        &self,
        session: &str,
        parent: &CancellationToken,
    ) -> Result<RunLease, SessionError> {
        if session.is_empty() || session.len() > 128 || parent.is_cancelled() {
            return Err(SessionError::Invalid);
        }
        let mut active = self.active.lock().map_err(|_| SessionError::Storage)?;
        active.retain(|_, run| !run.token.is_cancelled());
        if active.contains_key(session) || active.len() >= 1024 {
            return Err(SessionError::Conflict);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let token = parent.child_token();
        active.insert(
            session.into(),
            ActiveRun {
                id: id.clone(),
                token: token.clone(),
            },
        );
        Ok(RunLease {
            active: self.active.clone(),
            session: session.into(),
            id,
            token,
        })
    }
    pub fn cancel(&self, session: &str, id: Option<&str>) -> Result<bool, SessionError> {
        let mut active = self.active.lock().map_err(|_| SessionError::Storage)?;
        let Some(run) = active.get(session) else {
            return Ok(false);
        };
        if id.is_some_and(|id| run.id != id) {
            return Ok(false);
        }
        run.token.cancel();
        active.remove(session);
        Ok(true)
    }
    pub fn active_id(&self, session: &str) -> Result<Option<String>, SessionError> {
        Ok(self
            .active
            .lock()
            .map_err(|_| SessionError::Storage)?
            .get(session)
            .filter(|run| !run.token.is_cancelled())
            .map(|run| run.id.clone()))
    }
}
impl RunLease {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
    pub fn commit<ResultValue>(
        &self,
        write: impl FnOnce() -> Result<ResultValue, SessionError>,
    ) -> Result<ResultValue, SessionError> {
        let mut active = self.active.lock().map_err(|_| SessionError::Storage)?;
        if self.token.is_cancelled()
            || active
                .get(&self.session)
                .is_none_or(|run| run.id != self.id)
        {
            return Err(SessionError::Conflict);
        }
        let result = write()?;
        active.remove(&self.session);
        Ok(result)
    }
}
impl Drop for RunLease {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut active) = self.active.lock()
            && active
                .get(&self.session)
                .is_some_and(|run| run.id == self.id)
        {
            active.remove(&self.session);
        }
    }
}
