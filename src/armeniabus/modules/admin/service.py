from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.armeniabus.api.errors import ApiError
from src.armeniabus.core.security import hash_password
from src.armeniabus.modules.admin.audit import record_audit
from src.armeniabus.modules.users.models import User, UserRole, UserStatus


class AdminCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)


async def create_admin(db: AsyncSession, data: AdminCreate) -> User:
    """Create a new administrator; never promote or overwrite an existing account."""
    user = User(
        email=str(data.email).lower(),
        password_hash=await run_in_threadpool(hash_password, data.password),
        role=UserRole.ADMIN,
        status=UserStatus.ACTIVE,
    )
    db.add(user)
    try:
        await db.flush()
        record_audit(db, user.id, "admin.created", "user", user.id)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if await db.scalar(select(User.id).where(User.email == str(data.email).lower())):
            raise ApiError(409, "EMAIL_EXISTS", "Account already exists; nothing changed") from None
        raise
    return user
