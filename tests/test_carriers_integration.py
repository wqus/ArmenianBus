import asyncio
import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import create_async_engine

from armeniabus.core.config import Settings
from armeniabus.core.security import hash_password
from armeniabus.main import create_app
from armeniabus.modules.admin.models import AuditLog
from armeniabus.modules.bookings.models import Booking
from armeniabus.modules.buses.models import Bus, Seat
from armeniabus.modules.carriers.models import CarrierProfile
from armeniabus.modules.payments.models import Payment
from armeniabus.modules.routes.models import Route
from armeniabus.modules.users.models import User, UserRole, UserStatus

pytestmark = pytest.mark.skipif(os.getenv("RUN_DB_TESTS") != "1", reason="requires test PostgreSQL")
PASSWORD = "Carrier-Test-Password-42!"


def admin_command(email):
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "armeniabus.cli",
            "create-admin",
            "--email",
            email,
            "--password-stdin",
        ],
        input=PASSWORD + "\n",
        text=True,
        capture_output=True,
        check=False,
    )


async def scalar(statement):
    engine = create_async_engine(Settings().database_url)
    try:
        async with engine.connect() as connection:
            return await connection.scalar(statement)
    finally:
        await engine.dispose()


async def cleanup(user_ids):
    engine = create_async_engine(Settings().database_url)
    try:
        async with engine.begin() as connection:
            carriers = select(CarrierProfile.id).where(CarrierProfile.user_id.in_(user_ids))
            buses = select(Bus.id).where(Bus.carrier_id.in_(carriers))
            routes = select(Route.id).where(Route.carrier_id.in_(carriers))
            bookings = select(Booking.id).where(Booking.route_id.in_(routes))
            payments = select(Payment.id).where(Payment.booking_id.in_(bookings))
            await connection.execute(
                delete(AuditLog).where(
                    AuditLog.entity_type == "payment", AuditLog.entity_id.in_(payments)
                )
            )
            await connection.execute(delete(Payment).where(Payment.booking_id.in_(bookings)))
            await connection.execute(
                delete(AuditLog).where(
                    AuditLog.entity_type == "booking", AuditLog.entity_id.in_(bookings)
                )
            )
            await connection.execute(delete(AuditLog).where(AuditLog.actor_user_id.in_(user_ids)))
            await connection.execute(delete(Booking).where(Booking.route_id.in_(routes)))
            await connection.execute(delete(Route).where(Route.carrier_id.in_(carriers)))
            await connection.execute(delete(Seat).where(Seat.bus_id.in_(buses)))
            await connection.execute(delete(Bus).where(Bus.carrier_id.in_(carriers)))
            await connection.execute(
                delete(CarrierProfile).where(CarrierProfile.user_id.in_(user_ids))
            )
            await connection.execute(delete(User).where(User.id.in_(user_ids)))
    finally:
        await engine.dispose()


class World:
    def __init__(self, client):
        self.client = client
        self.user_ids = []
        self.admin = None

    def login(self, email):
        response = self.client.post(
            "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        return {"Authorization": "Bearer " + response.json()["access_token"]}

    def account(self, role="CARRIER"):
        email = f"b3-{uuid.uuid4().hex}@example.com"
        data = {"email": email, "password": PASSWORD, "role": role}
        if role == "CARRIER":
            data.update(company_name="Test Carrier", phone="+37499123456")
        response = self.client.post("/api/v1/auth/register", json=data)
        assert response.status_code == 201, response.text
        self.user_ids.append(uuid.UUID(response.json()["id"]))
        return email, self.login(email)

    def profile(self, headers):
        response = self.client.get("/api/v1/carriers/me", headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    def status(self, profile_id, status):
        return self.client.patch(
            f"/api/v1/admin/carriers/{profile_id}/status",
            headers=self.admin,
            json={"status": status},
        )


@pytest.fixture
def world():
    with TestClient(create_app(Settings()), client=(f"b3-{uuid.uuid4().hex}", 50000)) as client:
        context = World(client)
        try:
            email = f"admin-{uuid.uuid4().hex}@example.com"
            result = admin_command(email)
            assert result.returncode == 0, result.stderr
            assert PASSWORD not in result.stdout + result.stderr
            context.user_ids.append(uuid.UUID(result.stdout.strip().split()[-1]))
            context.admin = context.login(email)
            yield context
        finally:
            asyncio.run(cleanup(context.user_ids))


def test_carrier_approval_bus_lifecycle_and_audit(world):
    client = world.client
    _, headers = world.account()
    profile = world.profile(headers)
    profile_id = profile["id"]
    assert profile["status"] == "PENDING"
    assert world.status(profile_id, "BLOCKED").status_code == 409
    assert (
        client.post(
            "/api/v1/buses", headers=headers, json={"name": "Tourismo", "capacity": 45}
        ).status_code
        == 403
    )
    edited = client.patch(
        "/api/v1/carriers/me", headers=headers, json={"company_name": "Updated Carrier"}
    )
    assert edited.status_code == 200
    assert edited.json()["company_name"] == "Updated Carrier"
    assert world.status(profile_id, "ACTIVE").status_code == 200
    assert world.status(profile_id, "ACTIVE").status_code == 200
    assert (
        client.patch(
            "/api/v1/carriers/me", headers=headers, json={"phone": "+37499123457"}
        ).status_code
        == 409
    )
    created = client.post(
        "/api/v1/buses", headers=headers, json={"name": "Tourismo", "capacity": 45}
    )
    assert created.status_code == 201, created.text
    bus = created.json()
    bus_id = bus["id"]
    assert len(bus["seats"]) == bus["capacity"] == 45
    assert [seat["seat_number"] for seat in bus["seats"]] == list(range(1, 46))
    assert len({seat["id"] for seat in bus["seats"]}) == 45
    assert all("status" not in seat for seat in bus["seats"])
    renamed = client.patch(f"/api/v1/buses/{bus_id}", headers=headers, json={"name": "Setra"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Setra"
    assert renamed.json()["seats"] == bus["seats"]
    assert (
        client.patch(f"/api/v1/buses/{bus_id}", headers=headers, json={"capacity": 20}).status_code
        == 422
    )
    listed = client.get("/api/v1/buses?limit=1&offset=0", headers=headers).json()
    assert [item["id"] for item in listed["items"]] == [bus_id]
    assert world.status(profile_id, "BLOCKED").status_code == 200
    for method, path, body in [
        ("get", "/api/v1/buses", None),
        ("post", "/api/v1/buses", {"name": "Other", "capacity": 2}),
        ("get", f"/api/v1/buses/{bus_id}", None),
        ("patch", f"/api/v1/buses/{bus_id}", {"name": "Blocked edit"}),
        ("delete", f"/api/v1/buses/{bus_id}", None),
    ]:
        response = client.request(method, path, headers=headers, json=body)
        assert response.status_code == 403, response.text
    assert world.profile(headers)["status"] == "BLOCKED"
    assert world.status(profile_id, "ACTIVE").status_code == 200
    assert client.delete(f"/api/v1/buses/{bus_id}", headers=headers).status_code == 204
    assert client.get(f"/api/v1/buses/{bus_id}", headers=headers).status_code == 404
    assert client.get("/api/v1/buses", headers=headers).json()["items"] == []
    assert asyncio.run(scalar(select(Bus.archived_at).where(Bus.id == uuid.UUID(bus_id))))
    assert (
        asyncio.run(
            scalar(select(func.count()).select_from(Seat).where(Seat.bus_id == uuid.UUID(bus_id)))
        )
        == 45
    )
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.entity_id == uuid.UUID(profile_id),
                    AuditLog.action == "carrier.status_changed",
                )
            )
        )
        == 3
    )
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(AuditLog.entity_id == uuid.UUID(bus_id))
            )
        )
        == 3
    )


def test_ownership_role_checks_and_input_validation(world):
    _, owner = world.account()
    _, stranger = world.account()
    _, passenger = world.account("PASSENGER")
    for headers in (owner, stranger):
        assert world.status(world.profile(headers)["id"], "ACTIVE").status_code == 200
    bus = world.client.post(
        "/api/v1/buses", headers=owner, json={"name": "Owner bus", "capacity": 2}
    ).json()
    path = f"/api/v1/buses/{bus['id']}"
    for method, body in [("get", None), ("patch", {"name": "Stolen"}), ("delete", None)]:
        response = world.client.request(method, path, headers=stranger, json=body)
        assert response.status_code == 404
        assert response.json()["code"] == "BUS_NOT_FOUND"
    assert world.client.get("/api/v1/buses", headers=stranger).json()["items"] == []
    for headers in (passenger, world.admin):
        assert (
            world.client.post(
                "/api/v1/buses", headers=headers, json={"name": "Forbidden", "capacity": 3}
            ).status_code
            == 403
        )
    profile_id = world.profile(owner)["id"]
    assert (
        world.client.patch(
            f"/api/v1/admin/carriers/{profile_id}/status", headers=owner, json={"status": "BLOCKED"}
        ).status_code
        == 403
    )
    assert world.client.get("/api/v1/admin/carriers", headers=passenger).status_code == 403
    assert world.client.get("/api/v1/carriers/me", headers=passenger).status_code == 403
    assert world.client.get("/api/v1/buses").status_code == 401
    invalid = world.client.get("/api/v1/buses/not-a-uuid", headers=owner)
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "VALIDATION_ERROR"
    assert invalid.headers["X-Request-ID"] == invalid.json()["request_id"]
    for body in [
        {"name": "", "capacity": 2},
        {"name": "Bus", "capacity": 101},
        {"name": "Bus", "capacity": True},
        {"name": "Bus", "capacity": 2, "carrier_id": profile_id},
    ]:
        assert world.client.post("/api/v1/buses", headers=owner, json=body).status_code == 422
    assert world.client.get("/api/v1/buses?limit=101", headers=owner).status_code == 422
    assert world.client.get(path, headers=owner).json()["name"] == "Owner bus"


def test_carrier_registration_is_atomic_and_validated(world):
    email = f"invalid-{uuid.uuid4().hex}@example.com"
    base = {"email": email, "password": PASSWORD, "role": "CARRIER"}
    for data in [
        base,
        {**base, "company_name": " ", "phone": "+37499123456"},
        {**base, "company_name": "Carrier", "phone": "not-a-phone"},
        {**base, "company_name": "Carrier", "phone": "+37499123456", "status": "ACTIVE"},
    ]:
        assert world.client.post("/api/v1/auth/register", json=data).status_code == 422
    assert asyncio.run(scalar(select(User.id).where(User.email == email))) is None
    email, headers = world.account()
    duplicate = world.client.post(
        "/api/v1/auth/register",
        json={
            "email": email.upper(),
            "password": PASSWORD,
            "role": "CARRIER",
            "company_name": "Duplicate",
            "phone": "+37499123456",
        },
    )
    assert duplicate.status_code == 409
    profile = world.profile(headers)
    assert profile["company_name"] == "Test Carrier"
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(CarrierProfile)
                .where(CarrierProfile.user_id == uuid.UUID(profile["user_id"]))
            )
        )
        == 1
    )


def test_bootstrap_refuses_to_promote_an_existing_account(world):
    email, headers = world.account("PASSENGER")
    result = admin_command(email)
    assert result.returncode == 1
    assert "nothing changed" in result.stderr
    assert PASSWORD not in result.stdout + result.stderr
    assert world.client.get("/api/v1/me", headers=headers).json()["role"] == "PASSENGER"


async def seed_legacy_carrier():
    engine = create_async_engine(Settings().database_url)
    user_id = uuid.uuid4()
    email = f"legacy-{uuid.uuid4().hex}@example.com"
    try:
        async with engine.begin() as connection:
            await connection.execute(
                User.__table__.insert().values(
                    id=user_id,
                    email=email,
                    password_hash=hash_password(PASSWORD),
                    role=UserRole.CARRIER,
                    status=UserStatus.ACTIVE,
                )
            )
    finally:
        await engine.dispose()
    return user_id, email


def test_legacy_carrier_can_onboard_once_under_concurrent_requests(world):
    user_id, email = asyncio.run(seed_legacy_carrier())
    world.user_ids.append(user_id)
    headers = world.login(email)
    assert world.client.get("/api/v1/carriers/me", headers=headers).status_code == 404
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(
            pool.map(
                lambda _: world.client.post(
                    "/api/v1/carriers/me",
                    headers=headers,
                    json={"company_name": "Legacy Carrier", "phone": "+37499123456"},
                ),
                range(2),
            )
        )
    assert sorted(response.status_code for response in responses) == [201, 409]
    assert world.profile(headers)["status"] == "PENDING"
    assert (
        asyncio.run(
            scalar(
                select(func.count())
                .select_from(CarrierProfile)
                .where(CarrierProfile.user_id == user_id)
            )
        )
        == 1
    )
