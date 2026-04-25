import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import discord
from discord import app_commands
from discord.ext import commands
from aiohttp import web
from dotenv import load_dotenv


load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN", "")

# IDs hier eintragen
GUILD_ID = int(os.getenv("GUILD_ID", "0"))
PUNISHMENT_ROLE_ID = int(os.getenv("PUNISHMENT_ROLE_ID", "0"))
ADMIN_ROLE_IDS = [
    int(role_id.strip())
    for role_id in os.getenv("ADMIN_ROLE_IDS", "").split(",")
    if role_id.strip()
]

DATA_FILE = "strafen.json"
WEB_HOST = os.getenv("WEB_HOST", "0.0.0.0")
WEB_PORT = int(os.getenv("PORT", os.getenv("WEB_PORT", "8080")))


intents = discord.Intents.default()
intents.guilds = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents)
punishment_task: asyncio.Task | None = None


def ensure_data_file() -> None:
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, "w", encoding="utf-8") as file:
            json.dump([], file, indent=4)


def load_punishments() -> List[Dict[str, Any]]:
    ensure_data_file()
    with open(DATA_FILE, "r", encoding="utf-8") as file:
        return json.load(file)


def save_punishments(punishments: List[Dict[str, Any]]) -> None:
    with open(DATA_FILE, "w", encoding="utf-8") as file:
        json.dump(punishments, file, indent=4)


def parse_duration(duration_text: str) -> timedelta:
    duration_text = duration_text.strip().lower()
    if len(duration_text) < 2:
        raise ValueError("Ungueltiges Zeitformat.")

    unit = duration_text[-1]
    value_text = duration_text[:-1]

    if not value_text.isdigit():
        raise ValueError("Die Zeit muss mit einer Zahl beginnen.")

    value = int(value_text)
    if value <= 0:
        raise ValueError("Die Zeit muss groesser als 0 sein.")

    units = {
        "m": "minutes",
        "h": "hours",
        "d": "days",
    }

    if unit not in units:
        raise ValueError("Erlaubte Einheiten sind m, h und d.")

    return timedelta(**{units[unit]: value})


def has_admin_permission(member: discord.Member) -> bool:
    if member.guild_permissions.administrator:
        return True

    member_role_ids = {role.id for role in member.roles}
    return any(role_id in member_role_ids for role_id in ADMIN_ROLE_IDS)


async def restore_member_roles(guild: discord.Guild, punishment_entry: Dict[str, Any]) -> bool:
    member = guild.get_member(punishment_entry["user_id"])
    punishment_role = guild.get_role(PUNISHMENT_ROLE_ID)

    if member is None or punishment_role is None:
        return False

    stored_role_ids = punishment_entry.get("removed_role_ids", [])
    roles_to_restore = []

    for role_id in stored_role_ids:
        role = guild.get_role(role_id)
        if role is None:
            continue
        if role >= guild.me.top_role:
            continue
        roles_to_restore.append(role)

    current_roles = [role for role in member.roles if role.id != PUNISHMENT_ROLE_ID]
    updated_roles = [guild.default_role, *current_roles[1:]]

    for role in roles_to_restore:
        if role not in updated_roles:
            updated_roles.append(role)

    try:
        await member.edit(
            roles=updated_roles,
            reason="Bestrafung abgelaufen - Rollen wiederhergestellt",
        )
    except discord.Forbidden:
        return False

    return True


async def remove_expired_punishments() -> None:
    await bot.wait_until_ready()

    while not bot.is_closed():
        punishments = load_punishments()
        now = datetime.now(timezone.utc)
        remaining_entries = []

        for entry in punishments:
            expires_at = datetime.fromisoformat(entry["expires_at"])
            guild = bot.get_guild(entry["guild_id"])

            if guild is None:
                remaining_entries.append(entry)
                continue

            if expires_at <= now:
                restored = await restore_member_roles(guild, entry)
                if not restored:
                    remaining_entries.append(entry)
            else:
                remaining_entries.append(entry)

        save_punishments(remaining_entries)
        await asyncio.sleep(10)


async def healthcheck(_: web.Request) -> web.Response:
    return web.json_response(
        {
            "status": "ok",
            "bot_ready": bot.is_ready(),
            "latency_ms": round(bot.latency * 1000) if bot.is_ready() else None,
        }
    )


async def start_webserver() -> web.AppRunner:
    app = web.Application()
    app.router.add_get("/", healthcheck)
    app.router.add_get("/health", healthcheck)

    runner = web.AppRunner(app)
    await runner.setup()

    site = web.TCPSite(runner, host=WEB_HOST, port=WEB_PORT)
    await site.start()

    print(f"Webservice aktiv auf http://{WEB_HOST}:{WEB_PORT}")
    return runner


@bot.event
async def on_ready() -> None:
    ensure_data_file()

    try:
        synced = await bot.tree.sync(guild=discord.Object(id=GUILD_ID))
        print(f"Bot ist online als {bot.user} | {len(synced)} Slash-Commands synchronisiert.")
    except Exception as error:
        print(f"Fehler beim Synchronisieren der Commands: {error}")


async def setup_background_tasks() -> None:
    global punishment_task

    if punishment_task is None or punishment_task.done():
        punishment_task = asyncio.create_task(remove_expired_punishments())


@bot.tree.command(name="ping", description="Zeigt die Latenz des Bots an.", guild=discord.Object(id=GUILD_ID))
async def ping(interaction: discord.Interaction) -> None:
    await interaction.response.send_message(f"Pong! `{round(bot.latency * 1000)}ms`")


@bot.tree.command(
    name="bestrafung",
    description="Entzieht einem User fuer eine Zeit alle Rollen und gibt ihm die Strafen-Rolle.",
    guild=discord.Object(id=GUILD_ID),
)
@app_commands.describe(
    user="Der User, der bestraft werden soll",
    dauer="Zeitformat: 10m, 2h oder 1d",
)
async def bestrafung(
    interaction: discord.Interaction,
    user: discord.Member,
    dauer: str,
) -> None:
    if interaction.guild is None or not isinstance(interaction.user, discord.Member):
        await interaction.response.send_message("Dieser Command funktioniert nur auf einem Server.", ephemeral=True)
        return

    if not has_admin_permission(interaction.user):
        await interaction.response.send_message("Du darfst diesen Command nicht benutzen.", ephemeral=True)
        return

    if user == interaction.user:
        await interaction.response.send_message("Du kannst dich nicht selbst bestrafen.", ephemeral=True)
        return

    if user.guild_permissions.administrator or any(role.id in ADMIN_ROLE_IDS for role in user.roles):
        await interaction.response.send_message("Dieser User ist als Admin geschuetzt.", ephemeral=True)
        return

    punishment_role = interaction.guild.get_role(PUNISHMENT_ROLE_ID)
    if punishment_role is None:
        await interaction.response.send_message("Die Bestrafungs-Rolle wurde nicht gefunden.", ephemeral=True)
        return

    if interaction.guild.me is None or punishment_role >= interaction.guild.me.top_role:
        await interaction.response.send_message(
            "Die Bestrafungs-Rolle ist hoeher als meine Bot-Rolle oder gleich hoch.",
            ephemeral=True,
        )
        return

    try:
        duration_delta = parse_duration(dauer)
    except ValueError as error:
        await interaction.response.send_message(
            f"Ungueltige Zeit: {error} Beispiel: `10m`, `2h`, `1d`",
            ephemeral=True,
        )
        return

    existing_punishments = load_punishments()
    if any(
        entry["guild_id"] == interaction.guild.id and entry["user_id"] == user.id
        for entry in existing_punishments
    ):
        await interaction.response.send_message("Dieser User ist bereits bestraft.", ephemeral=True)
        return

    removed_roles = [
        role for role in user.roles
        if role != interaction.guild.default_role and role.id != PUNISHMENT_ROLE_ID
    ]

    if any(role >= interaction.guild.me.top_role for role in removed_roles):
        await interaction.response.send_message(
            "Ich kann nicht alle Rollen dieses Users verwalten. Pruefe die Rollen-Hierarchie.",
            ephemeral=True,
        )
        return

    expires_at = datetime.now(timezone.utc) + duration_delta

    try:
        await user.edit(
            roles=[interaction.guild.default_role, punishment_role],
            reason=f"Bestrafung fuer {dauer} durch {interaction.user}",
        )
    except discord.Forbidden:
        await interaction.response.send_message(
            "Ich konnte die Rollen nicht aendern. Pruefe meine Rechte und Rollen-Hierarchie.",
            ephemeral=True,
        )
        return

    existing_punishments.append(
        {
            "guild_id": interaction.guild.id,
            "user_id": user.id,
            "removed_role_ids": [role.id for role in removed_roles],
            "expires_at": expires_at.isoformat(),
        }
    )
    save_punishments(existing_punishments)

    await interaction.response.send_message(
        f"{user.mention} wurde fuer `{dauer}` bestraft. Ablauf: <t:{int(expires_at.timestamp())}:F>"
    )


async def main() -> None:
    ensure_data_file()
    if not TOKEN:
        raise ValueError("DISCORD_TOKEN fehlt in der .env Datei.")
    if GUILD_ID == 0:
        raise ValueError("GUILD_ID fehlt in der .env Datei.")
    if PUNISHMENT_ROLE_ID == 0:
        raise ValueError("PUNISHMENT_ROLE_ID fehlt in der .env Datei.")
    if not ADMIN_ROLE_IDS:
        raise ValueError("ADMIN_ROLE_IDS fehlt in der .env Datei.")

    web_runner = await start_webserver()

    try:
        await setup_background_tasks()
        await bot.start(TOKEN)
    finally:
        if punishment_task is not None:
            punishment_task.cancel()
            try:
                await punishment_task
            except asyncio.CancelledError:
                pass
        await web_runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
