from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def create_session_factory(database_url: str):
    engine = create_async_engine(database_url, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    return engine, sessions


async def get_db_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db_sessions() as session:
        yield session
