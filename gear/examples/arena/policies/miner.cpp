#include "sdk.h"
#include <queue>
#include <cstring>

// Small transparent baseline used only for controlled integration validation.
extern "C" void player_ai(Map& map, GameInfo&, RoundInfo& info, Action& action) {
    action.move = Action::Stop;
    action.blink_pos = Position(0, 0);
    action.setOB = false;
    action.buy_protect = false;
    // Remember previously observed terrain; visibility is only local each turn.
    static int known[31][31];
    if (info.round == 0)
        for (int x = 0; x < 31; ++x)
            for (int y = 0; y < 31; ++y) known[x][y] = MapGrid::UNSEEN;
    for (int x = 0; x < 31; ++x)
        for (int y = 0; y < 31; ++y)
            if (map.grids[x][y].terrain != MapGrid::UNSEEN)
                known[x][y] = map.grids[x][y].terrain;
    Position start;
    for (const auto& player : info.players)
        if (player.owner == info.player_id) start = player.pos;
    if (start.x < 0 || start.x >= 31 || start.y < 0 || start.y >= 31) return;
    int dist[31][31], first[31][31];
    std::memset(dist, -1, sizeof(dist));
    std::memset(first, 0, sizeof(first));
    std::queue<Position> queue;
    queue.push(start); dist[start.x][start.y] = 0;
    const int dx[] = {0, -1, 0, 1}, dy[] = {1, 0, -1, 0};
    const int moves[] = {Action::Up, Action::Left, Action::Down, Action::Right};
    Position explore = start;
    int explore_distance = 100000;
    while (!queue.empty()) {
        Position p = queue.front(); queue.pop();
        for (const auto& mine : info.mines) {
            if (mine.pos == p && mine.owner != info.player_id) {
                action.move = static_cast<Action::Move>(first[p.x][p.y]);
                return;
            }
        }
        for (int k = 0; k < 4; ++k) {
            int x = p.x + dx[k], y = p.y + dy[k];
            if (x < 0 || x >= 31 || y < 0 || y >= 31 || dist[x][y] >= 0 || known[x][y] == MapGrid::BLOCK) continue;
            dist[x][y] = dist[p.x][p.y] + 1;
            first[x][y] = p == start ? moves[k] : first[p.x][p.y];
            if (known[x][y] == MapGrid::UNSEEN) {
                if (dist[x][y] < explore_distance) { explore = Position(x, y); explore_distance = dist[x][y]; }
            } else queue.push(Position(x, y));
        }
    }
    action.move = static_cast<Action::Move>(first[explore.x][explore.y]);
}
