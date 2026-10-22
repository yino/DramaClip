"""story_arc：十二张叙事母题卡——id 唯一、菜单可渲染、结构卡三段骨架齐全。"""

from __future__ import annotations

from dramaclip.engines.narration import story_arc


def test_twelve_cards_with_unique_ids_and_names() -> None:
    cards = [story_arc.card_of(arc_id) for arc_id in story_arc.ids()]
    assert len(cards) == 12
    assert all(card is not None for card in cards)
    names = [card.name for card in cards if card is not None]
    assert len(set(names)) == 12, "母题人读名重复：方案卡徽标会分不清"


def test_owner_defined_three_arcs_present() -> None:
    """业主定义的三张卡在库：id 不变，卡名随全库统一为手法式四字。"""
    assert story_arc.card_of(story_arc.GLORY_FIRST) is not None
    assert story_arc.card_of(story_arc.UNDERDOG) is not None
    assert story_arc.card_of(story_arc.FOLK_TALE) is not None


def test_every_card_has_three_part_structure() -> None:
    """结构卡必须可执行：开场/中段/结尾三段各有明确指令，不许写成散文理论。"""
    for arc_id in story_arc.ids():
        card = story_arc.card_of(arc_id)
        assert card is not None
        assert "开场：" in card.structure, f"{arc_id} 缺开场指令"
        assert "中段：" in card.structure or "结尾：" in card.structure
        assert card.essence, f"{arc_id} 缺看点本质"


def test_card_of_unknown_returns_none() -> None:
    assert story_arc.card_of("nope") is None
    assert story_arc.card_of("") is None


def test_resolve_accepts_id_name_and_menu_form() -> None:
    """模型把中文名当 arc 回来（实测 '先扬后揭'）时归一成 id；三种写法都要认。"""
    assert story_arc.resolve("glory_first") == "glory_first"
    assert story_arc.resolve("先扬后揭") == "glory_first"
    assert story_arc.resolve("先扬后揭(glory_first)") == "glory_first"
    assert story_arc.resolve("  glory_first  ") == "glory_first"


def test_resolve_unknown_returns_empty() -> None:
    assert story_arc.resolve("hero_journey") == ""
    assert story_arc.resolve("") == ""


def test_card_of_accepts_chinese_name() -> None:
    """旧库/旧方案里存的是中文名时也能取到结构卡（调用方不再静默丢卡）。"""
    card = story_arc.card_of("先扬后揭")
    assert card is not None
    assert card.arc_id == story_arc.GLORY_FIRST


def test_menu_line_puts_id_before_name() -> None:
    """菜单写成「id（中文名）」：id 在前，减少模型把中文名当 arc 的概率。"""
    menu = story_arc.menu_line()
    assert menu.index(story_arc.GLORY_FIRST) < menu.index("先扬后揭")


def test_menu_line_lists_all_cards() -> None:
    menu = story_arc.menu_line()
    for arc_id in story_arc.ids():
        card = story_arc.card_of(arc_id)
        assert card is not None
        assert card.name in menu and card.arc_id in menu
