use llmup_runtime::state::{Config, StateStore};
use std::{
    io::{BufRead, Write},
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("mode required")?;
    let home = args.next().ok_or("isolated home required")?;
    let store = StateStore::new(Config::from_home(home)?);
    let guard = store.lock(Duration::from_millis(100))?;
    if mode == "hold" {
        println!("locked");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
    } else if mode != "roundtrip" {
        return Err("unknown mode".into());
    }
    let state = store.read()?;
    store.write(&guard, &state)?;
    guard.release()?;
    Ok(())
}
