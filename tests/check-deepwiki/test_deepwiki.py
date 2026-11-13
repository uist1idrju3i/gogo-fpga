import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deepwiki", ROOT / ".github/scripts/check-deepwiki.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def config():
    return {"repo_notes": [], "pages": [{"title": "概要", "purpose": "構成を説明する"}]}


class DeepWikiTests(unittest.TestCase):
    def test_repository_config(self):
        pages, notes = CHECK.validate(CHECK.load_config(ROOT / ".devin/wiki.json"))
        self.assertGreater(pages, 0)
        self.assertLessEqual(notes, CHECK.MAX_NOTES)

    def test_minimal_and_optional_fields(self):
        value = config()
        self.assertEqual(CHECK.validate(value), (1, 0))
        value["repo_notes"] = [{"content": "日本語", "author": "保守担当"}]
        value["pages"][0].update(parent=None, page_notes=[])
        value["pages"].insert(0, {"title": "子", "purpose": "詳細", "parent": "概要",
                                  "page_notes": [{"content": "補足"}]})
        self.assertEqual(CHECK.validate(value), (2, 2))

    def test_page_limit_boundary(self):
        value = config()
        value["pages"] = [{"title": str(i), "purpose": "説明"} for i in range(30)]
        self.assertEqual(CHECK.validate(value), (30, 0))
        value["pages"].append({"title": "extra", "purpose": "説明"})
        with self.assertRaisesRegex(ValueError, "1 to 30"):
            CHECK.validate(value)

    def test_combined_note_limit_boundary(self):
        value = config()
        value["repo_notes"] = [{"content": "共通"}] * 50
        value["pages"][0]["page_notes"] = [{"content": "個別"}] * 50
        self.assertEqual(CHECK.validate(value), (1, 100))
        value["pages"][0]["page_notes"].append({"content": "超過"})
        with self.assertRaisesRegex(ValueError, "total exceeds 100"):
            CHECK.validate(value)

    def test_note_character_limit_applies_to_both_arrays(self):
        for location in ("repo", "page"):
            with self.subTest(location=location):
                value = config()
                note = {"content": "あ" * 10000}
                if location == "repo":
                    value["repo_notes"] = [note]
                else:
                    value["pages"][0]["page_notes"] = [note]
                CHECK.validate(value)
                note["content"] += "あ"
                with self.assertRaisesRegex(ValueError, "10000 characters"):
                    CHECK.validate(value)

    def test_missing_empty_and_wrong_types(self):
        invalid = [None, [], {}, {"pages": []}, {"repo_notes": []}]
        for key, values in {"repo_notes": [None, {}, "notes"],
                            "pages": [None, {}, "pages", []]}.items():
            for value in values:
                changed = config()
                changed[key] = value
                invalid.append(changed)
        for key in ("title", "purpose", "parent", "page_notes"):
            values = [False, 1, {}, None, "notes"] if key == "page_notes" else [False, 1, {}, []]
            if key != "page_notes":
                values += ["", " "]
            if key in ("title", "purpose"):
                values.append(None)
            for value in values:
                changed = config()
                changed["pages"][0][key] = value
                invalid.append(changed)
        for page in [None, "page", {}, {"title": "概要"}, {"purpose": "説明"}]:
            changed = config()
            changed["pages"] = [page]
            invalid.append(changed)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                CHECK.validate(value)

    def test_note_shape_and_unknown_fields(self):
        for note in [None, "note", {}, {"content": None}, {"content": " "},
                     {"content": 3}, {"content": "説明", "author": None},
                     {"content": "説明", "author": ""}, {"content": "説明", "typo": True}]:
            for location in ("repo", "page"):
                value = config()
                target = value if location == "repo" else value["pages"][0]
                target["repo_notes" if location == "repo" else "page_notes"] = [note]
                with self.subTest(note=note, location=location), self.assertRaises(ValueError):
                    CHECK.validate(value)
        for location in ("root", "page"):
            value = config()
            target = value if location == "root" else value["pages"][0]
            target["unknown"] = True
            with self.assertRaises(ValueError):
                CHECK.validate(value)

    def test_titles_parent_references_and_cycles(self):
        for pages in [
            [{"title": "概要", "purpose": "説明"}] * 2,
            [{"title": " 概要", "purpose": "説明"}],
            [{"title": "概要", "purpose": "説明", "parent": "missing"}],
            [{"title": "概要", "purpose": "説明", "parent": "概要"}],
            [{"title": "a", "purpose": "説明", "parent": "b"},
             {"title": "b", "purpose": "説明", "parent": "a"}],
        ]:
            value = config()
            value["pages"] = copy.deepcopy(pages)
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                CHECK.validate(value)

    def test_cli_fails_closed_for_missing_and_malformed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wiki.json"
            samples = [None, b"", b"{", b"\xff", b"null", b"{\"pages\": [], \"pages\": []}",
                       b"{\"repo_notes\": [], \"pages\": [], \"x\": NaN}",
                       b"{\"repo_notes\": [{\"content\": \"a\", \"content\": \"b\"}], \"pages\": []}"]
            for content in samples:
                if content is not None:
                    path.write_bytes(content)
                result = subprocess.run([sys.executable, str(SPEC.origin), str(path)],
                                        capture_output=True, text=True)
                with self.subTest(content=content):
                    self.assertEqual(result.returncode, 1)
                    self.assertIn("DeepWiki config: ERROR:", result.stderr)
            path.write_text(json.dumps(config()), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SPEC.origin), str(path)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("DeepWiki config: OK (1/30 pages, 0/100 notes)", result.stdout)

    def test_json_parser_rejects_duplicate_keys_and_nonstandard_constants(self):
        valid_pages = json.dumps(config()["pages"])
        samples = [
            ('{"repo_notes": [], "pages": ' + valid_pages + ', "pages": ' + valid_pages + '}',
             "duplicate JSON key"),
            ('{"repo_notes": [{"content": "a", "content": "b"}], "pages": ' + valid_pages + '}',
             "duplicate JSON key"),
        ]
        samples += [(value, "invalid JSON constant") for value in ("NaN", "Infinity", "-Infinity")]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wiki.json"
            for content, message in samples:
                path.write_text(content, encoding="utf-8")
                with self.subTest(content=content), self.assertRaisesRegex(ValueError, message):
                    CHECK.load_config(path)


if __name__ == "__main__":
    unittest.main()
