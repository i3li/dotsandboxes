/*

1. The player sends a match command
  - CP: Current player
  - WP: The player in the waiting seat
  1.A. If there is no WP, the CP wait in the waiting seat
    * WP must sends a match command each WAITING_TIME_THRESHOLD_MS milliseonds to prove their connection
  1.B. If there is a WP
    1.B.A. If the WP has been waiting for more than WAITING_TIME_THRESHOLD_MS, discard their existence and wait in their place
    1.B.A. If the WP has not been waiting for more than WAITING_TIME_THRESHOLD_MS, match WP with CP (Create a new game and send the game id to both players in /playerState/)
2. The game starts with the player1 (WP) turn
  * The player must play under PLAY_TIME_MS milliseonds
    * How to enforce that?
      The client for the player in turn sends a quit command when the time runs out.
      Moreover, the opponent player sends a claimTimeout command to say that the other player ran out of time.
3. The player sends a move command.
  3.1. The handler validates the move
  3.2. If the move is valid update the game status
  3.3 Check if the game has ended and determine the winner.

 */


const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// Constants
const WAITING_TIME_THRESHOLD_MS = 10 * 1000;
const PLAY_TIME_MS = 30 * 1000;
const GRID = [3, 4];

const lastLine = GRID[0] * (GRID[1] + 1) + GRID[1] * (GRID[0] + 1);

/**
 * Create the game after matching two players
 * @param  String player1 The id of the first player
 * @param  String player2 The id of the second player
 * @return Promise
 */
function createGame(player1, player2) {
  const gamesCollectionRef = db.collection('games');
  return gamesCollectionRef.add({
    createdAt: Date.now(),
    player1: player1,
    player2: player2,
    turn: player1
  }).then(documentReference => {
    const gameID = documentReference.id;
    const playerStateCollectionRef = db.collection('playerState')
    const player1NotificatoinRef = playerStateCollectionRef.doc(player1).collection('notifications').doc();
    const player2NotificatoinRef = playerStateCollectionRef.doc(player2).collection('notifications').doc();
    const batch = db.batch();
    const newGameNotification = {
      type: 'newGame',
      params: {
        gameID: gameID
      }
    };
    batch.set(player1NotificatoinRef, newGameNotification);
    batch.set(player2NotificatoinRef, newGameNotification);
    return batch.commit();
  });
}

/**
 * Handle Match command
 * @param  Object params a JSON object containing the user id (i.e. {userID: 'uid'})
 * @return Promise
 */
function handleMatch(params) {
  // Command structure:
  // {
  //  type: 'match',
  //  params: {
  //    userID: 'uid'
  //  }
  // }
  // The function checks the waiting seat for a waiting user.
  // If there is no waiting player, put the current user id in the waiting seat and log the current timestamp.
  // If there is a waiting player, clear the waiting seat. Then, check the timestamp:
  //     If the timestamp is greater than WAITING_SEAT_TS, discard the waiting player. Then call the function again.
  //     Otherwise, create a new game and put the id in the playerState for each player
  // **waitingSeat must be manually created in the database** TODO: FIX THIS
  const waitingSeatRef = db.collection('global').doc('waitingSeat');
  return waitingSeatRef.get().then(snapshot => {
    const waitingUser = snapshot.data().user;
    const since = snapshot.data().since;
    const waitingTimeMS = Date.now() - since;
    const currentUser = params.userID
    if (waitingUser && waitingUser !== currentUser && waitingTimeMS <= WAITING_TIME_THRESHOLD_MS) {
      // Someone is waiting
      console.log(waitingUser + ' is already waiting since ' + waitingTimeMS + 'ms');
      // Delete the already waiting user
      return snapshot.ref.set({user: null}).then(res => {
        return createGame(waitingUser, currentUser);
      });
    } else {
      // No one is waiting
      console.log('No one is waiting');
      // Put the current user in the waiting seat
      return waitingSeatRef.set({user: currentUser, since: Date.now()});
    }
  });
}

/**
 * Handle CancelMatch command
 * @param  Object params a JSON object containing the user id (i.e. {userID: 'uid'})
 * @return Promise
 */
function handleCancelMatch(params) {
  const waitingSeatRef = db.collection('global').doc('waitingSeat');
  return waitingSeatRef.get().then(snapshot => {
    const waitingUser = snapshot.data().user;
    const since = snapshot.data().since;
    const waitingTimeMS = Date.now() - since;
    const currentUser = params.userID;
    // If waitingTimeMS > WAITING_TIME_THRESHOLD_MS, then there is no need to delete it. It will be discrded by the next matcher.
    if (waitingUser === currentUser && waitingTimeMS <= WAITING_TIME_THRESHOLD_MS) {
      return snapshot.ref.set({user: null});
    }
    return null;
  });
}

/**
 * @param  int line
 * @return array      All the boxes that includes the line 'line'.
 */
function lineBoxes(line) {
  // Populate grid
  // The line numbering system:
  //  - Start by 1
  //  - The first line is the top left vertical line
  //  - The second is the vertical line to the right of the first line
  //  - and so forth until the top right vertical line
  //  - Then, continue from the below rows until the last vertical line (bottom right vertical line)
  //  - Then, the same for the horizontal lines
  //  For example:
  //  A 2x2 board
  //
  //            ___ 07 ___      ___ 08 ___
  //         |               |               |
  //         01              02              03
  //         |               |               |
  //            ___ 09 ___      ___ 10 ___
  //         |               |               |
  //         04              05              06
  //         |               |               |
  //            ___ 11 ___      ___ 12 ___

  const boxes = [];
  const numberOfVerticalLines = (GRID[1] + 1) * GRID[0];
  for (i = 1; i <= GRID[0] * GRID[1]; i++) {
    const row = Math.ceil(i / GRID[1]) - 1; // Row starts From 0
    const left = i + row;
    const top = numberOfVerticalLines + i;
    const right = left + 1;
    const bottom = top + GRID[1];
    boxes.push([left, top, right, bottom]);
  }
  return boxes.filter(box => box.includes(line));
}

/**
 * Determine if a line will close boxes
 * @param  int line
 * @param  DocumentReference gameRef The reference to the game
 * @return Promise         Resolved with the number of boxes that will be closed by 'line'
 */
function lineClosesBox(line, gameRef) {
  const linesRef = gameRef.collection('lines');
  // Get candidate boxes
  const lBoxes = lineBoxes(line);
  const linePromises = [];
  const playedLines = [];
  for (lineBox of lBoxes) {
    for (line of lineBox) {
      const linePromise = linesRef.doc(line.toString()).get().then(lineDoc => {
        if (lineDoc.exists) {
          const line = parseInt(lineDoc.id);
          playedLines.push(line);
        }
        return null;
      });
      linePromises.push(linePromise);
    }
  }
  var numberOfBoxesClosedByLine = 0;
  return new Promise(res, rej => {
    return Promise.all(linePromises).then(result => {
      for (lineBox of lBoxes) {
        const playedLinesInLineBox = lineBox.filter(l => playedLines.includes(l));
        if (playedLinesInLineBox.length === 3) { // The current line closes this box
          numberOfBoxesClosedByLine++;
        }
      }
      res(numberOfBoxesClosedByLine);
      return null;
    });
  });
}

/**
  * Handle Move command
  * @param  Object params a JSON object containing the user id, the game id and the line to be played (i.e. params: {userID: 'uid', gameID: 'gid', line: line#})
  * @return Promise
 */
function handleMove(params) {
  // Move
  // 1. The player writes a move command
  // 2. Validate the move:
  //   2.1. Check if the game is on and it is the turn of userID
  //   2.2. Check if the line# is valid and not occupied
  // 3. Add the line to the games/gameID/lines subcollection
  // 4. Check if the line closes a box.
  //  4.1. If it does:
  //  4.1.1. Increase player#Boxes by the number of box that got closed.
  //  4.1.2. Check if all the boxes are closed and determine the winner in that case
  //  4.2. If it does not:
  //  4.2.1. Flip the turn
  const gameID = params.gameID;
  const userID = params.userID;
  const line = params.line;
  if (line < 1 || line > lastLine) { return null; }
  const gameRef = db.collection('games').doc(gameID);
  return gameRef.get().then(snapshot => {
    const gameData = snapshot.data();
    const player1 = gameData.player1;
    const player2 = gameData.player2;
    const player1Boxes = gameData.player1Boxes;
    const player2Boxes = gameData.player2Boxes;
    const numberOfLines = gameData.numberOfLines;
    const turn = gameData.turn;
    if (!gameData.winner && (turn === player1 && player1 === userID || turn === player2 && player2 === userID)) {
      const lineRef = gameRef.collection('lines').doc(line.toString());
      return lineRef.get().then(snapshot => {
        if (!snapshot.exists) {

          // Determine if the new line closes a box
          return lineClosesBox(line, gameRef).then(numberOfBoxesClosedByLine => {
            var batch = db.batch();

            if (numberOfBoxesClosedByLine > 0) {

              if (turn === player1) {
                batch.update(gameRef, {
                  player1Boxes: admin.firestore.FieldValue.increment(numberOfBoxesClosedByLine)
                });
              } else {
                batch.update(gameRef, {
                  player2Boxes: admin.firestore.FieldValue.increment(numberOfBoxesClosedByLine)
                });
              }
              // Determine if game ended
              if (player1Boxes + player2Boxes + numberOfBoxesClosedByLine === GRID[0] * GRID[1]) {
                // Determine the winner
                var winner = 'DRAW';
                if (player1Boxes > player2Boxes) {
                  winner = player1
                } else if (player2Boxes > player1Boxes) {
                  winner = player2
                }
                batch.update(gameRef, {
                  winner: winner
                });
              }

            } else {
              // Flip turn
              batch.update(gameRef, {
                turn: turn === player1 ? player2 : player1
              });
            }

            batch.set(lineRef, {
                playedAt: Date.now(),
                by: userID
              });
            return batch.commit();
          });
        }
        return null;
      });
    }
    return null;
  });
}

// TODO: Implementation
function handleQuit(params) {

}

// TODO: Implementation
function handleClaimTimeout(params) {

}

exports.commandHandler = functions.firestore
  .document('commands/{commandID}')
  .onCreate((snapshot, context) => {
    // General Command structure:
    // {
    //   type: // 'match', etc.
    //   params: { // Depends on the command.
    //   }
    // }
    const command = snapshot.data()
    const commandType = command.type;
    const commandParams = command.params;
    switch (commandType) {
      case 'match':
        return handleMatch(commandParams);
      case 'cancelMatch':
        return handleCancelMatch(commandParams);
      case 'move':
        return handleMove(commandParams);
      case 'claimTimeout':
        return handleClaimTimeout(commandParams);
      case 'quit':
        return handleQuit(commandParams);
      default: break;
    }
    return null;
  });
