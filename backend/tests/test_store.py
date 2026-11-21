"""Persistent conversation and deletion invariants."""
from store import ConversationStore


def test_messages_survive_reopening_database(tmp_path):
    db = tmp_path / "vishu.sqlite3"
    original = ConversationStore(db)
    item = original.create_conversation("Persistent chat")
    original.append_exchange(item["id"], "first message", "first response")
    reopened = ConversationStore(db)
    messages = reopened.list_messages(item["id"])
    assert [row["content"] for row in messages] == [
        "first message", "first response"
    ]
    assert len(reopened.list_conversations()) == 1


def test_delete_cascades_messages(tmp_path):
    store = ConversationStore(tmp_path / "vishu.sqlite3")
    first = store.create_conversation("First")
    second = store.create_conversation("Second")
    store.append_exchange(first["id"], "hello", "world")
    store.append_exchange(second["id"], "keep", "me")
    assert store.delete_conversation(first["id"]) is True
    assert store.delete_conversation(first["id"]) is False
    assert store.list_messages(first["id"]) == []
    assert len(store.list_messages(second["id"])) == 2


def test_model_history_limited_and_ordered(tmp_path):
    store = ConversationStore(tmp_path / "vishu.sqlite3")
    conversation = store.create_conversation()
    for number in range(20):
        store.append_exchange(conversation["id"], "q" + str(number), "a" + str(number))
    history = store.model_history(conversation["id"], limit=4)
    assert [entry["content"] for entry in history] == ["q18", "a18", "q19", "a19"]
