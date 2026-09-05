//! JSON-lines sidecar wrapping [Azalea](https://github.com/azalea-rs/azalea).
//!
//! Protocol (stdin = commands, stdout = events, stderr = tracing):
//!   first stdin line: {"op":"start","host","port","username","uuid","token","proxy"?}
//!   later commands:   {"op":"chat"|"disconnect"|"walk"|"jump"|"look"|"select"|"use"|"drop"|"sneak"|"closeWindow"|"clickWindow"}
//!   events:           {"ev":"log"|"chat"|"status"|"error"|"death"|"player_add"|"player_remove"|"snapshot"|"end", ...}

use std::{
    collections::VecDeque,
    future::Future,
    io::{self, BufRead, Write},
    net::ToSocketAddrs,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc,
    },
};

use azalea::{
    account::AccountTrait,
    inventory::{operations::{PickupClick, ThrowClick}, ItemStack, Menu},
    prelude::*,
    protocol::connect::Proxy,
    ClientInformation, JoinOpts,
};
use azalea_auth::sessionserver::{
    join as session_join, ClientSessionServerError, SessionServerJoinOpts,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{error, info, warn};
use uuid::Uuid;

fn emit(v: &Value) {
    let mut out = io::stdout();
    if writeln!(out, "{v}").is_ok() {
        let _ = out.flush();
    }
}

fn log_line(level: &str, line: impl AsRef<str>) {
    emit(&json!({ "ev": "log", "level": level, "line": line.as_ref() }));
}

fn parse_uuid(raw: &str) -> eyre::Result<Uuid> {
    let s = raw.trim().replace('-', "");
    if s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        let dashed = format!(
            "{}-{}-{}-{}-{}",
            &s[0..8],
            &s[8..12],
            &s[12..16],
            &s[16..20],
            &s[20..32]
        );
        return Ok(Uuid::parse_str(&dashed)?);
    }
    Ok(Uuid::parse_str(raw.trim())?)
}

#[derive(Debug)]
struct TokenAccount {
    username: String,
    uuid: Uuid,
    access_token: Mutex<String>,
    certs: Mutex<Option<azalea_auth::certs::Certificates>>,
}

impl AccountTrait for TokenAccount {
    fn username(&self) -> &str {
        &self.username
    }
    fn uuid(&self) -> Uuid {
        self.uuid
    }
    fn access_token(&self) -> Option<String> {
        Some(self.access_token.lock().clone())
    }
    fn certs(&self) -> Option<azalea_auth::certs::Certificates> {
        self.certs.lock().clone()
    }
    fn set_certs(&self, certs: azalea_auth::certs::Certificates) {
        *self.certs.lock() = Some(certs);
    }
    fn join<'a>(
        &'a self,
        public_key: &'a [u8],
        private_key: &'a [u8; 16],
        server_id: &'a str,
        proxy: Option<reqwest::Proxy>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ClientSessionServerError>> + Send + 'a>> {
        Box::pin(async move {
            let access_token = self.access_token.lock().clone();
            session_join(SessionServerJoinOpts {
                access_token: &access_token,
                public_key,
                private_key: private_key.as_slice(),
                uuid: &self.uuid,
                server_id,
                proxy,
            })
            .await
        })
    }
}

#[derive(Debug, Deserialize)]
struct StartMsg {
    op: String,
    host: String,
    port: u16,
    username: String,
    uuid: String,
    token: String,
    #[serde(default)]
    proxy: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Cmd {
    op: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    on: Option<bool>,
    #[serde(default)]
    slot: Option<u8>,
    #[serde(default)]
    ms: Option<u64>,
}

#[derive(Clone, Component, Default)]
struct State {
    cmds: Arc<Mutex<VecDeque<Cmd>>>,
    walk_until_tick: Arc<Mutex<Option<u32>>>,
    tick: Arc<Mutex<u32>>,
    /// Live client handle + connection state, so commands can be applied on a
    /// wall-clock loop instead of only inside `Event::Tick` (which only fires
    /// while the world is loaded — it stops during proxy server switches, e.g.
    /// Minemen lobby → duel arena, which used to strand every chat command).
    client: Arc<Mutex<Option<Client>>>,
    online: Arc<Mutex<bool>>,
    last_tick: Arc<Mutex<Option<std::time::Instant>>>,
    last_stall_report: Arc<Mutex<u64>>,
    disconnect_times: Arc<Mutex<VecDeque<std::time::Instant>>>,
    /// Set while a worker thread is applying commands; keeps batches ordered
    /// and prevents piling calls onto a possibly-wedged ECS.
    applier_busy: Arc<AtomicBool>,
}

fn parse_socks5(raw: &str) -> Option<Proxy> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let mut rest = s;
    if let Some(stripped) = rest
        .strip_prefix("socks5://")
        .or_else(|| rest.strip_prefix("socks5h://"))
        .or_else(|| rest.strip_prefix("socks://"))
    {
        rest = stripped;
    } else if rest.starts_with("socks4://") {
        warn!("Azalea only supports SOCKS5; ignoring SOCKS4 proxy");
        return None;
    }
    if let Some(at) = rest.rfind('@') {
        rest = &rest[at + 1..];
    }
    let addr = rest.to_socket_addrs().ok().and_then(|mut i| i.next());
    match addr {
        Some(addr) => Some(Proxy::new(addr, None)),
        None => {
            warn!("Could not resolve SOCKS proxy address {rest}");
            None
        }
    }
}

fn walk_dir(name: &str) -> azalea::WalkDirection {
    use azalea::WalkDirection::*;
    match name.to_ascii_lowercase().as_str() {
        "forward" | "w" => Forward,
        "back" | "backward" | "s" => Backward,
        "left" | "a" => Left,
        "right" | "d" => Right,
        "none" | "stop" => None,
        _ => None,
    }
}

fn display_name_from_id(id: &str) -> String {
    id.split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn kind_to_names(kind: &azalea::registry::builtin::ItemKind) -> (String, String) {
    let full = kind.to_string(); // minecraft:stone
    let name = full
        .strip_prefix("minecraft:")
        .unwrap_or(&full)
        .to_string();
    let display = display_name_from_id(&name);
    (name, display)
}

fn stack_to_json(slot: usize, stack: &ItemStack, selected: bool) -> Value {
    match stack {
        ItemStack::Empty => json!({
            "slot": slot,
            "name": null,
            "displayName": null,
            "count": 0,
            "selected": selected
        }),
        ItemStack::Present(data) => {
            let (name, display) = kind_to_names(&data.kind);
            json!({
                "slot": slot,
                "name": name,
                "displayName": display,
                "count": data.count,
                "selected": selected
            })
        }
    }
}

fn menu_title(menu: &Menu) -> String {
    match menu {
        Menu::Player(_) => "Player".to_string(),
        Menu::Generic9x1 { .. } => "Chest".to_string(),
        Menu::Generic9x2 { .. } => "Chest".to_string(),
        Menu::Generic9x3 { .. } => "Chest".to_string(),
        Menu::Generic9x4 { .. } => "Chest".to_string(),
        Menu::Generic9x5 { .. } => "Chest".to_string(),
        Menu::Generic9x6 { .. } => "Large Chest".to_string(),
        Menu::Generic3x3 { .. } => "Dispenser".to_string(),
        Menu::Crafter3x3 { .. } => "Crafter".to_string(),
        Menu::Anvil { .. } => "Anvil".to_string(),
        Menu::Beacon { .. } => "Beacon".to_string(),
        Menu::BlastFurnace { .. } => "Blast Furnace".to_string(),
        Menu::BrewingStand { .. } => "Brewing Stand".to_string(),
        Menu::Crafting { .. } => "Crafting".to_string(),
        Menu::Enchantment { .. } => "Enchantment".to_string(),
        Menu::Furnace { .. } => "Furnace".to_string(),
        Menu::Grindstone { .. } => "Grindstone".to_string(),
        Menu::Hopper { .. } => "Hopper".to_string(),
        Menu::Lectern { .. } => "Lectern".to_string(),
        Menu::Loom { .. } => "Loom".to_string(),
        Menu::Merchant { .. } => "Villager".to_string(),
        Menu::ShulkerBox { .. } => "Shulker Box".to_string(),
        Menu::Smithing { .. } => "Smithing".to_string(),
        Menu::Smoker { .. } => "Smoker".to_string(),
        Menu::CartographyTable { .. } => "Cartography".to_string(),
        Menu::Stonecutter { .. } => "Stonecutter".to_string(),
    }
}

fn apply_cmd(bot: &Client, state: &State, cmd: Cmd) {
    match cmd.op.as_str() {
        "chat" => {
            if let Some(text) = cmd.text {
                let is_cmd = text.starts_with('/');
                // Log what we're sending for debugging beam visibility
                let preview: String = text.chars().take(100).collect();
                if is_cmd {
                    log_line("system", format!("Azalea sending command: {}", preview));
                } else {
                    log_line("system", format!("Azalea sending chat: {}", preview));
                }
                // Azalea's chat() handles both signed chat and commands internally
                // Wrap in catch_unwind to avoid panic killing the sidecar
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    bot.chat(text.clone());
                }));
                match result {
                    Ok(_) => {
                        emit(&json!({ "ev": "log", "level": "system", "line": format!("chat sent: {} '{}'", if is_cmd { "cmd" } else { "msg" }, preview.chars().take(50).collect::<String>()) }));
                    }
                    Err(_) => {
                        log_line("error", format!("Azalea chat panic for: {}", preview));
                        emit(&json!({ "ev": "error", "line": format!("chat panic: {}", preview) }));
                    }
                }
            }
        }
        "disconnect" => {
            log_line("system", "Disconnect requested.");
            bot.disconnect();
            bot.exit();
        }
        "walk" | "move" => {
            let dir = cmd.dir.as_deref().unwrap_or("forward");
            let on = cmd.on.unwrap_or(true);
            if on {
                bot.walk(walk_dir(dir));
                if let Some(ms) = cmd.ms {
                    let ticks = ((ms as u32) / 50).max(1);
                    let now = *state.tick.lock();
                    *state.walk_until_tick.lock() = Some(now.saturating_add(ticks));
                }
            } else {
                bot.walk(azalea::WalkDirection::None);
                *state.walk_until_tick.lock() = None;
            }
        }
        "jump" => {
            bot.jump();
        }
        "sneak" => {
            let on = cmd.on.unwrap_or(true);
            bot.set_crouching(on);
        }
        "look" => {
            let pos = bot.position();
            bot.look_at(azalea::Vec3::new(pos.x + 2.0, pos.y + 1.6, pos.z));
        }
        "select" => {
            if let Some(slot) = cmd.slot {
                bot.set_selected_hotbar_slot(slot.min(8));
            }
        }
        "use" => {
            bot.start_use_item();
        }
        "use_stop" => {}
        "drop" => {
            // Drop entire stack in selected hotbar slot via ThrowClick::All
            let menu = bot.menu();
            let hotbar_range = menu.hotbar_slots_range();
            let selected = bot.selected_hotbar_slot() as usize;
            let slot_idx = *hotbar_range.start() + selected;
            let inv = bot.get_inventory();
            inv.click(ThrowClick::All {
                slot: slot_idx as u16,
            });
            log_line("system", format!("Dropped slot {}", selected));
        }
        "clickWindow" => {
            if let Some(slot) = cmd.slot {
                let inv = bot.get_inventory();
                // left click the window slot
                inv.click(PickupClick::Left {
                    slot: Some(slot as u16),
                });
                log_line("system", format!("Clicked window slot {}", slot));
            }
        }
        "closeWindow" => {
            let inv = bot.get_inventory();
            inv.close();
            log_line("system", "Closed container");
        }
        other => {
            warn!("unknown command op={other}");
        }
    }
}

fn facing_from_yaw(yaw_deg: f32) -> &'static str {
    let deg = ((yaw_deg % 360.0) + 360.0) % 360.0;
    let i = ((deg + 22.5) / 45.0).floor() as usize % 8;
    ["S", "SW", "W", "NW", "N", "NE", "E", "SE"][i]
}

fn snapshot(bot: &Client) -> Value {
    // Position, direction, hunger, health – all infallible in 0.16 docs.rs
    let pos = bot.position();
    let hunger = bot.hunger();
    let food = hunger.food as f64;
    let dir = bot.direction();
    let yaw = dir.y_rot() as f64;
    let pitch = dir.x_rot() as f64;
    let selected = bot.selected_hotbar_slot();
    let health = bot.health() as f64;

    // Inventory: real hotbar via menu
    let menu = bot.menu();
    let all_slots = menu.slots();
    let hotbar_range = menu.hotbar_slots_range();
    let hotbar_start = *hotbar_range.start();

    let mut hotbar_json = Vec::with_capacity(9);
    for i in 0..9 {
        let idx = hotbar_start + i;
        let stack = all_slots.get(idx).unwrap_or(&ItemStack::Empty);
        hotbar_json.push(stack_to_json(i, stack, i as u8 == selected));
    }

    // Held item
    let held_stack = bot.get_held_item();
    let held_json = match &held_stack {
        ItemStack::Empty => Value::Null,
        ItemStack::Present(data) => {
            let (name, _) = kind_to_names(&data.kind);
            json!(name)
        }
    };

    // Window: if not Player menu, show container contents via get_inventory().contents()
    let window_json = match &menu {
        Menu::Player(_) => Value::Null,
        _ => {
            let inv = bot.get_inventory();
            let maybe_contents = inv.contents();
            let title = menu_title(&menu);
            if let Some(contents) = maybe_contents {
                let slots: Vec<Value> = contents
                    .iter()
                    .enumerate()
                    .map(|(i, s)| match s {
                        ItemStack::Empty => Value::Null,
                        ItemStack::Present(data) => {
                            let (name, display) = kind_to_names(&data.kind);
                            json!({
                                "slot": i,
                                "name": name,
                                "displayName": display,
                                "count": data.count
                            })
                        }
                    })
                    .collect();
                json!({
                    "title": title,
                    "slots": slots
                })
            } else {
                // fallback: empty window with title
                json!({
                    "title": title,
                    "slots": []
                })
            }
        }
    };

    json!({
        "ev": "snapshot",
        "available": true,
        "username": bot.username(),
        "position": { "x": pos.x, "y": pos.y, "z": pos.z },
        "health": health,
        "food": food,
        "yaw": yaw,
        "pitch": pitch,
        "facing": facing_from_yaw(dir.y_rot()),
        "dimension": "overworld",
        "timeOfDay": 0,
        "isDay": true,
        "heldItem": held_json,
        "lookingAt": null,
        "entities": [],
        "nearbyBlocks": [],
        "hotbar": hotbar_json,
        "selectedSlot": selected,
        "using": false,
        "window": window_json
    })
}

async fn handle(bot: Client, event: Event, state: State) -> eyre::Result<()> {
    match event {
        Event::Init => {
            log_line("system", "Azalea client initialized.");
            *state.client.lock() = Some(bot.clone());
            *state.online.lock() = false;
            *state.last_tick.lock() = None;
            bot.set_client_information(ClientInformation {
                view_distance: 12,
                ..Default::default()
            });
        }
        Event::Login => {
            log_line("system", "Logged in to the server.");
            *state.client.lock() = Some(bot.clone());
            // Drop commands queued from the previous session so a reconnect
            // doesn't flush stale chat/messages all at once.
            state.cmds.lock().clear();
            emit(&json!({ "ev": "status", "status": "online" }));
        }
        Event::Spawn => {
            log_line(
                "system",
                format!("✅ Spawned in the world as {} (Azalea / vanilla physics).", bot.username()),
            );
            *state.client.lock() = Some(bot.clone());
            *state.online.lock() = true;
            *state.last_tick.lock() = Some(std::time::Instant::now());
            emit(&json!({ "ev": "status", "status": "online" }));
            emit(&snapshot(&bot));
        }
        Event::Chat(m) => {
            let line = m.message().to_string();
            if !line.is_empty() {
                emit(&json!({ "ev": "chat", "line": line }));
            }
        }
        Event::Tick => {
            *state.last_tick.lock() = Some(std::time::Instant::now());
            let tick = {
                let mut t = state.tick.lock();
                *t = t.wrapping_add(1);
                *t
            };
            if let Some(until) = *state.walk_until_tick.lock() {
                if tick >= until {
                    bot.walk(azalea::WalkDirection::None);
                    *state.walk_until_tick.lock() = None;
                }
            }
            // NOTE: commands are no longer drained here. They are applied by a
            // dedicated wall-clock task in main() so chat keeps working even
            // when the world isn't ticking (arena/server switches).
            if tick % 10 == 0 {
                emit(&snapshot(&bot));
            }
        }
        Event::Death(_) => {
            emit(&json!({ "ev": "death" }));
            log_line("system", "Died.");
        }
        Event::AddPlayer(info) => {
            let name = info.profile.name.clone();
            if !name.is_empty() {
                emit(&json!({ "ev": "player_add", "name": name }));
            }
        }
        Event::RemovePlayer(info) => {
            let name = info.profile.name.clone();
            if !name.is_empty() {
                emit(&json!({ "ev": "player_remove", "name": name }));
            }
        }
        Event::Disconnect(reason) => {
            let text = reason
                .map(|r| r.to_string())
                .unwrap_or_else(|| "disconnected".to_string());
            *state.online.lock() = false;
            *state.client.lock() = None;
            *state.last_tick.lock() = None;
            // Rate-limit reconnects: if we've been kicked 4+ times in the last
            // 5 minutes, stop retrying and shut down so the dashboard shows a
            // real error instead of an infinite kick/rejoin loop (e.g. banned).
            let now = std::time::Instant::now();
            let too_many = {
                let mut times = state.disconnect_times.lock();
                times.push_back(now);
                while times
                    .front()
                    .map_or(false, |f| now.duration_since(*f).as_secs() > 300)
                {
                    times.pop_front();
                }
                times.len() > 3
            };
            if too_many {
                emit(&json!({ "ev": "error", "line": format!("Disconnected: {text}") }));
                emit(&json!({ "ev": "end", "line": text }));
                bot.exit();
            } else {
                // reconnect_after is enabled, so azalea will rejoin on its own;
                // stay alive so chat commands keep queueing for the next session.
                log_line(
                    "system",
                    format!("Disconnected ({text}); auto-reconnecting in a few seconds…"),
                );
            }
        }
        Event::ConnectionFailed(err) => {
            let text = format!("Connection failed: {err}");
            emit(&json!({ "ev": "error", "line": text }));
            emit(&json!({ "ev": "end", "line": text }));
            bot.exit();
        }
        _ => {}
    }
    Ok(())
}

// NOTE: current_thread flavor is REQUIRED, not an optimization. Azalea's docs
// warn that calling client methods from a plain `tokio::spawn` task lets Tokio
// schedule a Minecraft tick / handler at an unexpected moment, breaking ECS
// invariants — which is exactly how the client wedged (ticks + chat die, the
// process lives) when the beam fired walk//msg commands during a world switch.
// Everything that touches the Client must run on this thread's LocalSet.
#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    log_line("system", "Azalea bridge starting (Minecraft 26.1 protocol).");

    let mut first = String::new();
    io::stdin().lock().read_line(&mut first)?;
    let start: StartMsg = serde_json::from_str(first.trim())
        .map_err(|e| eyre::eyre!("invalid start JSON: {e}"))?;
    if start.op != "start" {
        eyre::bail!("first message must be op=start, got {}", start.op);
    }

    let uuid = parse_uuid(&start.uuid)?;
    let account: Account = TokenAccount {
        username: start.username.clone(),
        uuid,
        access_token: Mutex::new(start.token.clone()),
        certs: Mutex::new(None),
    }
    .into();

    let address = format!("{}:{}", start.host, start.port);
    log_line(
        "system",
        format!(
            "Connecting to {address} as {} ({}) via Azalea…",
            start.username, uuid
        ),
    );

    let mut opts = JoinOpts::new();
    if let Some(raw) = start.proxy.as_deref().filter(|s| !s.is_empty()) {
        if let Some(proxy) = parse_socks5(raw) {
            log_line("system", "Routing Azalea through SOCKS5 proxy.");
            opts = opts.proxy(proxy);
        } else {
            log_line(
                "system",
                "Proxy string could not be parsed as SOCKS5; connecting directly.",
            );
        }
    }

    let cmds: Arc<Mutex<VecDeque<Cmd>>> = Arc::new(Mutex::new(VecDeque::new()));

    let state = State {
        cmds,
        walk_until_tick: Arc::new(Mutex::new(None)),
        tick: Arc::new(Mutex::new(0)),
        client: Arc::new(Mutex::new(None)),
        online: Arc::new(Mutex::new(false)),
        last_tick: Arc::new(Mutex::new(None)),
        last_stall_report: Arc::new(Mutex::new(0)),
        disconnect_times: Arc::new(Mutex::new(VecDeque::new())),
        applier_busy: Arc::new(AtomicBool::new(false)),
    };

    // All tasks below run on a LocalSet on this single thread (see the note on
    // the current_thread tokio flavor above). Never use plain tokio::spawn for
    // anything that touches the azalea Client.
    let local = tokio::task::LocalSet::new();

    // Stdin command reader → queue (queue-only, no Client access).
    {
        let st = state.clone();
        local.spawn_local(async move {
            use tokio::io::AsyncBufReadExt;
            let stdin = tokio::io::stdin();
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let line = line.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Cmd>(&line) {
                            Ok(cmd) => st.cmds.lock().push_back(cmd),
                            Err(e) => warn!("bad command JSON: {e} ({line})"),
                        }
                    }
                    Ok(None) => {
                        st.cmds.lock().push_back(Cmd {
                            op: "disconnect".into(),
                            text: None,
                            dir: None,
                            on: None,
                            slot: None,
                            ms: None,
                        });
                        break;
                    }
                    Err(e) => {
                        error!("stdin error: {e}");
                        break;
                    }
                }
            }
        });
    }

    // Command applier, hardened against the world-switch deadlock:
    //  1. World-switch gating — a Client call (walk/chat) that lands while the
    //     server is switching worlds (ticks paused) blocks on an ECS lock that
    //     is held across an await, and on this single-threaded runtime that
    //     deadlocks the WHOLE process (heartbeat included). So commands are
    //     only applied while the world is ticking normally (<1.5s tick age);
    //     otherwise they're held until ticks resume (dropped after 20s).
    //  2. Off-thread application — even when fresh, commands run on a
    //     disposable OS thread, so if a call still wedges it kills only that
    //     worker, never the runtime thread: the heartbeat stays alive and the
    //     Node supervisor gets a clean zombie detection → restart.
    {
        let st = state.clone();
        local.spawn_local(async move {
            let mut holding_since: Option<std::time::Instant> = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                if !*st.online.lock() {
                    continue; // not spawned yet — commands queue until Spawn
                }
                let fresh = st
                    .last_tick
                    .lock()
                    .as_ref()
                    .map(|t| t.elapsed() < std::time::Duration::from_millis(1500))
                    .unwrap_or(false);
                if !fresh {
                    let mut q = st.cmds.lock();
                    if q.is_empty() {
                        holding_since = None;
                        continue;
                    }
                    match holding_since {
                        None => {
                            holding_since = Some(std::time::Instant::now());
                            log_line(
                                "system",
                                "World switch in progress — holding commands until ticks resume…",
                            );
                        }
                        Some(t) if t.elapsed().as_secs() >= 20 => {
                            let n = q.len();
                            q.clear();
                            holding_since = None;
                            log_line(
                                "system",
                                format!("Dropped {n} held command(s): world did not resume within 20s."),
                            );
                        }
                        _ => {}
                    }
                    continue;
                }
                holding_since = None;
                if st.applier_busy.swap(true, AtomicOrdering::SeqCst) {
                    continue; // previous batch still applying off-thread
                }
                let cmds: Vec<Cmd> = st.cmds.lock().drain(..).collect();
                let client = st.client.lock().clone();
                match client {
                    Some(client) if !cmds.is_empty() => {
                        let st2 = st.clone();
                        std::thread::spawn(move || {
                            for cmd in cmds {
                                apply_cmd(&client, &st2, cmd);
                            }
                            st2.applier_busy.store(false, AtomicOrdering::SeqCst);
                        });
                    }
                    _ => {
                        st.applier_busy.store(false, AtomicOrdering::SeqCst);
                    }
                }
            }
        });
    }

    // Watchdog + heartbeat:
    //  - Event::Tick only fires while the world is loaded; if ticks die while
    //    we're connected (arena-switch wedge), chat events and snapshots die
    //    with them → force a reconnect so the client recovers.
    //  - A heartbeat every ~2s lets the Node supervisor tell "sidecar alive"
    //    from "process wedged" and restart the whole sidecar if needed.
    {
        let st = state.clone();
        local.spawn_local(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let online = *st.online.lock();
                let tick_age_s = st.last_tick.lock().as_ref().map(|t| t.elapsed().as_secs());
                emit(&json!({ "ev": "hb", "online": online, "tick_age_s": tick_age_s }));

                let connected = st.client.lock().is_some();
                if !connected {
                    *st.last_stall_report.lock() = 0;
                    continue;
                }
                let stalled_secs = tick_age_s.unwrap_or(0);
                if stalled_secs >= 30 {
                    if stalled_secs - *st.last_stall_report.lock() >= 30 {
                        *st.last_stall_report.lock() = stalled_secs;
                        log_line(
                            "system",
                            format!(
                                "⚠ No world ticks for {stalled_secs}s while connected (stuck after a server switch?) — forcing reconnect to recover chat."
                            ),
                        );
                        let client = st.client.lock().clone();
                        if let Some(client) = client {
                            // Run on a disposable OS thread — disconnect() can
                            // block on the same ECS lock that wedged the applier,
                            // and it must never kill the runtime thread (heartbeat).
                            std::thread::spawn(move || {
                                let _ = std::panic::catch_unwind(
                                    std::panic::AssertUnwindSafe(|| client.disconnect()),
                                );
                            });
                        }
                    }
                } else if stalled_secs >= 6 {
                    let reported = *st.last_stall_report.lock();
                    if stalled_secs - reported >= 10 {
                        *st.last_stall_report.lock() = stalled_secs;
                        log_line(
                            "system",
                            format!("World ticks paused for {stalled_secs}s (loading chunks / switching servers)…"),
                        );
                    }
                } else {
                    *st.last_stall_report.lock() = 0;
                }
            }
        });
    }

    info!("joining {address}");
    local
        .run_until(async move {
            ClientBuilder::new()
                .set_handler(handle)
                .set_state(state)
                .reconnect_after(Some(std::time::Duration::from_secs(5)))
                .start_with_opts(account, address.as_str(), opts)
                .await;
        })
        .await;

    emit(&json!({ "ev": "end", "line": "azalea exited" }));
    Ok(())
}
