#include "sdk.h"
extern "C" void player_ai(Map&, GameInfo&, RoundInfo&, Action& action) {
    action.move = Action::Stop;
    action.blink_pos = Position(0, 0);
    action.setOB = false;
    action.buy_protect = false;
}
