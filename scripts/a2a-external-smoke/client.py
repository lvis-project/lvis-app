# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "a2a-sdk==1.1.0",
#   "httpx==0.28.1",
# ]
# ///

from __future__ import annotations

import asyncio
import os

import httpx
from a2a.client.client import Client, ClientConfig
from a2a.client.client_factory import ClientFactory
from a2a.client.errors import A2AClientError
from a2a.types import a2a_pb2 as a2a


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def send_request(
    message_id: str,
    text: str,
    *,
    task_id: str = "",
    context_id: str = "",
    return_immediately: bool = False,
) -> a2a.SendMessageRequest:
    message = a2a.Message(
        message_id=message_id,
        role=a2a.ROLE_USER,
        parts=[a2a.Part(text=text)],
    )
    if task_id:
        message.task_id = task_id
    if context_id:
        message.context_id = context_id
    return a2a.SendMessageRequest(
        message=message,
        configuration=a2a.SendMessageConfiguration(
            accepted_output_modes=["text/plain"],
            history_length=16,
            return_immediately=return_immediately,
        ),
    )


async def open_client(base_url: str, bearer: str) -> Client:
    http_client = httpx.AsyncClient(
        headers={"Authorization": f"Bearer {bearer}"},
        timeout=10.0,
    )
    config = ClientConfig(streaming=False, polling=False, httpx_client=http_client)
    try:
        return await ClientFactory(config).create_from_url(base_url)
    except Exception:
        await http_client.aclose()
        raise


async def send_task(client: Client, request: a2a.SendMessageRequest) -> a2a.Task:
    responses = [response async for response in client.send_message(request)]
    check(len(responses) == 1, "SendMessage returned an unexpected response count")
    response = responses[0]
    check(response.HasField("task"), "SendMessage did not return a task")
    return response.task


async def unauthorized_phase(base_url: str, bearer: str) -> None:
    client = await open_client(base_url, bearer)
    try:
        try:
            await send_task(
                client,
                send_request("message-unauthorized", "complete-request"),
            )
        except A2AClientError as error:
            cause = error.__cause__
            check(
                isinstance(cause, httpx.HTTPStatusError)
                and cause.response.status_code == 401,
                "official SDK did not preserve the HTTP 401 authentication failure",
            )
        else:
            raise AssertionError("wrong bearer unexpectedly authorized a mutation")
    finally:
        await client.close()


async def scenario_phase(base_url: str, bearer: str) -> None:
    client = await open_client(base_url, bearer)
    try:
        completed = await send_task(
            client,
            send_request("message-complete", "complete-request"),
        )
        check(
            completed.status.state == a2a.TASK_STATE_COMPLETED,
            "blocking SendMessage did not complete",
        )
        completed_get = await client.get_task(
            a2a.GetTaskRequest(id=completed.id, history_length=16),
        )
        check(
            completed_get.status.state == a2a.TASK_STATE_COMPLETED,
            "GetTask did not preserve COMPLETED",
        )

        waiting = await send_task(
            client,
            send_request("message-wait", "wait-request"),
        )
        check(
            waiting.status.state == a2a.TASK_STATE_INPUT_REQUIRED,
            "blocking SendMessage did not return INPUT_REQUIRED",
        )
        continued = await send_task(
            client,
            send_request(
                "message-answer",
                "continue-request",
                task_id=waiting.id,
                context_id=waiting.context_id,
            ),
        )
        check(continued.id == waiting.id, "continuation changed the task id")
        check(
            continued.context_id == waiting.context_id,
            "continuation changed the context id",
        )
        check(
            continued.status.state == a2a.TASK_STATE_COMPLETED,
            "continuation did not complete",
        )
        continued_get = await client.get_task(
            a2a.GetTaskRequest(id=waiting.id, history_length=16),
        )
        user_messages = [
            message
            for message in continued_get.history
            if message.role == a2a.ROLE_USER
        ]
        check(
            len(user_messages) == 2,
            "continued task history did not retain both user messages",
        )

        working = await send_task(
            client,
            send_request(
                "message-cancel",
                "cancel-request",
                return_immediately=True,
            ),
        )
        check(
            working.status.state == a2a.TASK_STATE_WORKING,
            "non-blocking SendMessage did not return WORKING",
        )
        canceled = await client.cancel_task(a2a.CancelTaskRequest(id=working.id))
        check(
            canceled.status.state == a2a.TASK_STATE_CANCELED,
            "CancelTask did not return CANCELED",
        )
        canceled_get = await client.get_task(
            a2a.GetTaskRequest(id=working.id, history_length=16),
        )
        check(
            canceled_get.status.state == a2a.TASK_STATE_CANCELED,
            "GetTask did not preserve CANCELED",
        )
    finally:
        await client.close()


async def main() -> None:
    base_url = require_env("A2A_SMOKE_BASE_URL")
    bearer = require_env("A2A_SMOKE_BEARER")
    phase = require_env("A2A_SMOKE_PHASE")
    if phase == "unauthorized":
        await unauthorized_phase(base_url, bearer)
    elif phase == "scenarios":
        await scenario_phase(base_url, bearer)
    else:
        raise RuntimeError(f"unsupported smoke phase: {phase}")
    print(f"official Python A2A SDK smoke ({phase}): passed")


if __name__ == "__main__":
    asyncio.run(main())
