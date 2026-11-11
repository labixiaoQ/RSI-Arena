// Trusted development test. Compile against the pinned, unchanged judge source.
#define main original_monecraft_main
#include "/opt/monecraft/logic/src/logic.cc"
#undef main
#include <cassert>

static void reset_state() {
  PLAYER_NUM = 2;
  MINE_NUM = 6;
  game_info = GameInfo{};
  observers.clear();
  ob_id = 0;
  err_flag = false;
  for (int x = 0; x < MAP_WIDTH; x++) for (int y = 0; y < MAP_HEIGHT; y++) {
    game_map.grids[x][y] = MapGrid{};
    game_map.grids[x][y].terrain = MapGrid::FLAT;
    game_map.grids[x][y].pos = Position(x, y);
  }
  for (int i = 0; i < PLAYER_NUM; i++) {
    game_players[i] = Player{};
    game_players[i].owner = i;
    game_players[i].pos = Position(10 + i, 10);
    game_map.grids[10 + i][10].players.push_back(i);
    ob_num[i] = 0;
  }
  for (int i = 0; i < MINE_NUM; i++) {
    game_mines[i] = Mine{};
    game_mines[i].id = i;
    game_mines[i].pos = Position(2 + i, 2);
    game_map.grids[2 + i][2].mine_id = i;
  }
}

int main() {
  const Action::Move moves[] = {Action::Up, Action::Down, Action::Left, Action::Right};
  const Position destinations[] = {Position(10,11), Position(10,9), Position(9,10), Position(11,10)};
  for (int i = 0; i < 4; i++) {
    reset_state(); Action action{}; action.move = moves[i];
    move_player(game_players[0], action);
    assert(game_players[0].pos == destinations[i]);
  }
  reset_state();
  Action action{}; action.move = Action::Up;
  game_map.grids[10][11].terrain = MapGrid::BLOCK;
  move_player(game_players[0], action);
  assert(game_players[0].pos == Position(10,10));
  action.move = Action::Blink; action.blink_pos = Position(12,12);
  move_player(game_players[0], action);
  assert(game_players[0].pos == Position(12,12) && game_players[0].blink_cd == 5);
  action.blink_pos = Position(14,14);
  move_player(game_players[0], action);
  assert(game_players[0].pos == Position(12,12));
  reset_state(); action = Action{}; action.move = Action::Blink; action.blink_pos = Position(13,10);
  move_player(game_players[0], action);
  assert(game_players[0].pos == Position(10,10));

  for (int seat = 0; seat < 2; seat++) {
    reset_state();
    game_map.grids[2][2].players = {seat};
    for (int i = 0; i < 4; i++) mine_change();
    assert(game_mines[0].owner == -1);
    mine_change(); calc_mine_num(); get_gold();
    assert(game_mines[0].owner == seat && game_info.mine_num[seat] == 1 && game_info.golds[seat] == 10);
    game_map.grids[2][2].players = {1 - seat};
    game_mines[0].protect_round = 2;
    const int point = game_mines[0].own_point;
    mine_change(); assert(game_mines[0].own_point == point);
    mine_change(); assert(game_mines[0].own_point == point);
    for (int i = 0; i < 5; i++) mine_change();
    assert(game_mines[0].owner == -1);
    for (int i = 0; i < 5; i++) mine_change();
    assert(game_mines[0].owner == 1 - seat);
  }
  reset_state(); action = Action{}; action.move = Action::Right; action.setOB = true;
  move_player(game_players[0], action);
  assert(observers.size() == 1 && observers[0].pos == Position(10,10) && game_info.golds[0] == 0);
  calc_ob_num(); game_info.golds[0] = 10;
  move_player(game_players[0], action);
  assert(observers.size() == 2 && game_info.golds[0] == 0);
  reset_state();
  game_map.grids[10][10].mine_id = 0; game_mines[0].owner = 0; game_info.mine_num[0] = 1; game_info.golds[0] = 100;
  action = Action{}; action.move = Action::Right; action.buy_protect = true;
  move_player(game_players[0], action);
  assert(game_mines[0].protect_round == 80 && game_info.golds[0] == 0);

  reset_state();
  for (int x = 0; x < MAP_WIDTH; x++) for (int y = 0; y < MAP_HEIGHT; y++) game_map.grids[x][y].terrain = MapGrid::BLOCK;
  game_map.grids[10][10].terrain = MapGrid::FLAT;
  calc_view();
  assert(view[0](10,10) && view[0](11,11) && view[0](2,2) && !view[0](20,20));
  reset_state(); assert(get_winner() == -1);
  game_info.mine_num[1] = 1; assert(get_winner() == 1);
  game_info.golds[0] = 1; assert(get_winner() == 0);
  err_flag = true; winner = 1; assert(get_winner() == 1);
  std::cout << "{\"status\":\"passed\",\"source\":\"pinned upstream judge\",\"checks\":[\"directions\",\"blocked_move\",\"blink_range_and_cooldown\",\"capture_both_seats\",\"protection\",\"observer_cost_and_old_position\",\"visibility\",\"winner_and_error\"]}" << std::endl;
}
