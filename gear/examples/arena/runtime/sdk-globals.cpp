#include "sdk.h"

// The pinned two-player fight mode generates exactly six mines. The judge
// defines these variables internally but does not export them to player DSOs.
// They are public SDK values, not access to the judge's mutable state.
int PLAYER_NUM = MAX_PLAYER_NUM;
int MINE_NUM = 6;
