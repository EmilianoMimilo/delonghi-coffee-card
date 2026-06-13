# DeLonghi Coffee Card

A Lovelace card for Home Assistant to control De'Longhi connected coffee machines
(Coffee Link cloud) through the excellent
[delonghi_coffeelink](https://github.com/actabi/delonghi_coffeelink) custom integration.

Tested on a **De'Longhi Eletta Explore ECAM450.86.T** (DL-striker-cb), running daily
on an iPhone dashboard.

## Features

- ☕ **Full drink catalogue** — 21 beverages (espresso, cappuccino, latte macchiato,
  flat white, brew over ice…), the list shown is configurable
- ⭐ **Favorite button** — a big one-tap shortcut for your daily drink (default: espresso)
- 🛡️ **Two-tap arming** — first tap arms the drink, second tap confirms (no accidental brews)
- ⏱️ **Brewing countdown** — progress bar + remaining seconds while a drink is pouring
- 📜 **Last beverage** — shows which drink was made last (icon + name + time ago)
- ⏹️ **Stop button** while brewing, **Wake button** when the machine is in standby
- 📊 **Stats row** — total beverages, espresso count, grounds container, water hardness
  (tap a stat for the HA more-info dialog)
- 🌙 **Day/night aware accent** (via `sun.sun`)
- 📵 **Offline state** — based on the `connection_status` sensor (more reliable than
  entity availability with this cloud)

### Optional (advanced) features

These require a little extra setup on your side and are **off by default**:

- 🗑️ **Grounds container as a percentage** + a "container full" alert — needs a sensor
  that exposes the grounds percentage (`grounds_pct`).
- 🧼 **Descale alert** — needs a sensor whose state becomes `Requis` when descaling
  is needed (`descale`).
- 🎛️ **Setting selectors** (profile, temperature, auto-off…) — drive `input_select`
  helpers from the card (`settings`).
- 🔌 **On/off toggles** (energy saving, beep…) — drive `input_boolean` helpers
  from the card (`toggles`).
- ⏰ **Reliable wake via a custom service** (`wake_service`) — for firmwares where the
  native wake button doesn't actually power the machine on (e.g. `DL-striker-cb`).

## Requirements

- [actabi/delonghi_coffeelink](https://github.com/actabi/delonghi_coffeelink) installed
  and configured (it creates the `button.<serial>_*` and `sensor.<serial>_*` entities)

## Installation

1. Copy `dist/delonghi-coffee-card.js` to `/config/www/`
2. Add the resource: **Settings → Dashboards → Resources → Add**
   `/local/delonghi-coffee-card.js` (JavaScript module)
3. Add the card:

```yaml
type: custom:delonghi-coffee-card
device: ac000w012345678        # required — lowercase serial prefix of your entities
title: Cafetière
drinks:                        # optional — defaults to a sensible 6-drink list
  - espresso
  - double_espresso
  - cappuccino
  - latte_macchiato
  - long_coffee
  - hot_water
brew_seconds: 45               # optional — how long the "brewing" state is shown
```

All entity ids are derived from `device` and can be overridden individually
(`connection`, `stop`, `wake`, `counter`, `espresso_counter`, `grounds`, `hardness`).

### Optional config

```yaml
type: custom:delonghi-coffee-card
device: ac000w012345678
favorite: espresso              # big one-tap shortcut (set to false to hide)

# Grounds container as a % gauge + "full" alert (needs your own sensor)
grounds_pct: sensor.my_coffee_grounds_pct
grounds_warn: 80               # % threshold for the red/alert state (default 80)
descale: sensor.my_coffee_descale   # state "Requis" → descale alert

# Reliable wake for firmwares where the native wake button does nothing
wake_service: shell_command.cafe_wake   # any domain.service

# Setting selectors — each entry drives an input_select helper
settings:
  - { entity: input_select.cafe_profil,      icon: "👤", label: Profil }
  - { entity: input_select.cafe_temperature, icon: "🌡️", label: Température }
  - { entity: input_select.cafe_arret_auto,  icon: "⏱️", label: "Arrêt auto" }

# On/off toggles — each entry drives an input_boolean helper
toggles:
  - { entity: input_boolean.cafe_eco, icon: "🔋", label: "Économie d'énergie" }
  - { entity: input_boolean.cafe_bip, icon: "🔔", label: Bip }
```

The card only **reads/writes** these helpers — you decide what each helper does
(e.g. an automation that calls a `shell_command`). The card never talks to the
machine settings directly.

## Field notes (Eletta Explore / DL-striker-cb)

A few things learned the hard way, which may save you time:

- The machine only honours cloud commands when the `app_device_connected` heartbeat
  has been written first — recent versions of the integration handle this for you.
- The **wake** command never returns an `app_data_response` ack. That's normal —
  don't treat it as a failure.
- When the Ayla cloud has an outage (HTTP 504), the integration's coordinator can
  stay stuck on stale data after the cloud recovers; reloading the integration fixes it.
- There is no water-level sensor — the cloud simply doesn't expose one.

## License

MIT
