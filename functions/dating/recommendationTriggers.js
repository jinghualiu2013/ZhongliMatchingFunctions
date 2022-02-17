const functions = require('firebase-functions')
const admin = require('firebase-admin')
const geofirestore = require('geofirestore')

const batchUpdateLimit = 100
const minBatchAllowed = 15

const defaultAvatar =
  'https://www.iosapptemplates.com/wp-content/uploads/2019/06/empty-avatar.jpg'
const defaultUserSettings = {
  distance_radius: 'unlimited',
  gender: 'none',
  gender_preference: 'all',
  show_me: true,
}

// admin.initializeApp();
const firestore = admin.firestore
const db = admin.firestore()
const geoDB = geofirestore.initializeApp(db)

const wipeOutAllOldRecommendations = async (
  batch,
  myUserID,
  updateIsComputing,
) => {
  const recommendationsRef = firestore().collection('dating_recommendations')
  const myRecommendationsSnapshot = await recommendationsRef.doc(myUserID).get()
  const computedRecommendationsRef =
    myRecommendationsSnapshot.ref.collection('recommendations')
  const computedRecommendationsSnapshot = await computedRecommendationsRef.get()

  if (updateIsComputing) {
    myRecommendationsSnapshot.ref.set(
      { isComputingRecommendation: true },
      { merge: true },
    )
  }

  if (!computedRecommendationsSnapshot.empty) {
    computedRecommendationsSnapshot.docs.forEach(doc => batch.delete(doc.ref))
  }

  return myRecommendationsSnapshot
}

const generateCompatibleNearbyUsersQuery = user => {
  const userSettings = user.settings || defaultUserSettings
  const myLocation = user.location
  const myGenderPre = userSettings.gender_preference || 'all'
  const distanceRadius = (userSettings.distance_radius &&
    userSettings.distance_radius.toLowerCase() !== 'unlimited' &&
    userSettings.distance_radius.split(' ')) || ['10000']
  const mySearchRaduis = Number(distanceRadius[0])

  let query = geoDB
    .collection('users')
    .near({
      center: new firestore.GeoPoint(myLocation.latitude, myLocation.longitude),
      radius: mySearchRaduis, //kilometers
    })
    .where('settings.show_me', '==', true)

  console.log('++ myGenderPre ++' + myGenderPre)

  if (myGenderPre !== 'all') {
    query = query.where('settings.gender', '==', myGenderPre)
  }

  return query
}

const getDistanceField = distance => {
  const distanceInMiles = Math.round(distance / 1.609344)
  if (distanceInMiles >= 2.0) {
    return distanceInMiles + ' ' + 'miles away'
  }
  return '1 mile away'
}

const writeOnlyNewRecommendations = (
  batch,
  myUserID,
  swipes,
  compatibleUsersSnapshot,
  myRecommendationsSnapshot,
) => {
  const computedRecommendationsRef =
    myRecommendationsSnapshot.ref.collection('recommendations')
  const recommendations = []
  let myIndex = -1

  for (let index = 0; index < compatibleUsersSnapshot.docs.length; index++) {
    const doc = compatibleUsersSnapshot.docs[index]
    if (doc.id === myUserID) {
      myIndex = index
    } else {
      // if i am yet to swipe on other user, then update my recommendations with the other user
      if (!swipes[doc.id]) {
        recommendations.push(doc.data())
        batch.set(
          computedRecommendationsRef.doc(doc.id),
          Object.assign(doc.data() || {}, {
            distance: getDistanceField(doc.distance),
          }),
        )
      }
    }

    if (recommendations.length >= batchUpdateLimit) {
      break
    }
  }

  if (myIndex > -1) {
    recommendations.splice(myIndex, 1)
  }

  return recommendations
}

const getAllSwipes = async user => {
  let swipes = {}
  const likesRef = db.collection('user_swipes').doc(user.id).collection('likes')
  const dislikesRef = db
    .collection('user_swipes')
    .doc(user.id)
    .collection('dislikes')
  const likesSnapshot = await likesRef.get()
  const dislikesSnapshot = await dislikesRef.get()

  const formatSwipes = snapshot =>
    snapshot.docs.forEach(doc => {
      if (!doc.exists) {
        return
      }
      const data = doc.data()
      swipes = Object.assign(swipes, { [data.swipedProfileID]: data.type })
    })

  formatSwipes(likesSnapshot)
  formatSwipes(dislikesSnapshot)

  return swipes
}

/*
 ** Returns null if otherUser is not compatible with the search filters of the current user
 ** Otherwise, it appends the distance property to the otherUser object.
 */
const computeNewRecommendations = async (user, updateIsComputing = true) => {
  try {
    const batch = firestore().batch()
    const myRecommendationsSnapshot = await wipeOutAllOldRecommendations(
      batch,
      user.id,
      updateIsComputing,
    )

    const query = generateCompatibleNearbyUsersQuery(user)

    const compatibleUsersSnapshot = await query.get()

    const swipes = await getAllSwipes(user)

    const recommendations = writeOnlyNewRecommendations(
      batch,
      user.id,
      swipes,
      compatibleUsersSnapshot,
      myRecommendationsSnapshot,
    )

    console.log(
      '+++total rec for:' + user.email + 'is' + recommendations.length,
    )

    await batch.commit()

    myRecommendationsSnapshot.ref.update(
      { isComputingRecommendation: false },
      { merge: true },
    )

    return recommendations
  } catch (error) {
    console.log('+++++ computeNewRecommendations error', error)
  }
}

const getUserSettingsChanged = (prevUserData, newUserData) => {
  const { settings: prevUserSettings = defaultUserSettings } = prevUserData
  const { settings: newUserSettings = defaultUserSettings } = newUserData

  const distanceRadiusUpdated =
    prevUserSettings.distance_radius !== newUserSettings.distance_radius
  const genderPreferenceUpdated =
    prevUserSettings.gender_preference !== newUserSettings.gender_preference
  const showMeUpdated = prevUserSettings.show_me !== newUserSettings.show_me
  return distanceRadiusUpdated || genderPreferenceUpdated
}

const getCanComputeRecommendations = newUserData => {
  const {
    firstName,
    email,
    phone,
    profilePictureURL,
    hasComputedRcommendations,
  } = newUserData
  return (
    (firstName || '').trim() &&
    (email || phone) &&
    profilePictureURL &&
    !hasComputedRcommendations
    // &&
    // profilePictureURL != defaultAvatar // Uncomment this line if you don't want users with no avatar show up in the recommendations
  )
}

// we compute new recommendations for the user and
//  and update the user object with the currentRecommendationSize,  hasComputedRcommendations and settings.
const handleUserRecommendations = async (user, userRef, updateIsComputing) => {
  const recommendations = await computeNewRecommendations(
    user,
    updateIsComputing,
  )

  if (recommendations) {
    const dataToUpdate = {
      hasComputedRcommendations: true,
      currentRecommendationSize: recommendations.length,
    }
    if (!user.settings) {
      dataToUpdate.settings = defaultUserSettings
    }

    return userRef.update(dataToUpdate)
  }
}

/*
 ** When a user updates their profile info (profile picture, first name, settings, etc)
 ** We compute recommendations base on all valid fields updated
 */
exports.onUserDataWrite = functions.firestore
  .document('users/{userID}')
  .onWrite(async (change, context) => {
    const prevUserData = change.before.data()
    const newUserData = change.after.data()
    if (
      !change.after.exists ||
      !newUserData ||
      !newUserData.location.latitude
    ) {
      console.log('+++compute recommendations not allowed')
      return
    }

    const { hasComputedRcommendations } = newUserData

    const userSettingsChanged = getUserSettingsChanged(
      prevUserData,
      newUserData,
    )

    console.log('++++hasComputedRcommendations++++' + hasComputedRcommendations)

    console.log('++++userSettingsChanged++++' + userSettingsChanged)

    // if user  settings changed, and we have already computed recommendations
    // we should compute new recommendations base on the new settings
    if (hasComputedRcommendations && userSettingsChanged) {
      return handleUserRecommendations(newUserData, change.after.ref)
    }

    //We check to ensure all required fields are available before computing recommendations
    const canComputeRecommendations = getCanComputeRecommendations(newUserData)

    console.log('++++canComputeRecommendations++++' + canComputeRecommendations)

    if (!canComputeRecommendations) {
      return null
    }

    const coordinatesIsEqual = new firestore.GeoPoint(
      newUserData.location.latitude,
      newUserData.location.longitude,
    ).isEqual(newUserData.coordinates)

    // if user has no geopoint hash or user coordinates is not equal, that is, user coordinates did changed,
    // we update geopoint hash for user. Geopoint hash is needed to use geoQuery from geofirestore
    if (!newUserData.g || !coordinatesIsEqual) {
      return geoDB
        .collection('users')
        .doc(newUserData.id)
        .update({
          coordinates: new firestore.GeoPoint(
            newUserData.location.latitude,
            newUserData.location.longitude,
          ),
        })
    }

    if (!newUserData.settings) {
      change.after.ref.update({
        settings: defaultUserSettings,
      })
      // return
    }

    //If we haven't previously computed recommendations or hasComputedRcommendations is false for unknown reason,
    // then we compute new recommendations
    if (!hasComputedRcommendations) {
      return handleUserRecommendations(newUserData, change.after.ref)
    }

    return null
  })

/*
 ** When a user dating recommendations collection is updated and collection size is 10, we compute add new recommendations
 **
 */
exports.onUserRecommendationsUpdate = functions.firestore
  .document(
    'dating_recommendations/{userID}/recommendations/{recommendationID}',
  )
  .onDelete(async (change, context) => {
    if (typeof userID !== 'string') {
      return
    }

    const computedRecommendationsRef = db
      .collection('dating_recommendations')
      .doc(userID)
      .collection('recommendations')
    const userRef = db.collection('users').doc(userID)

    try {
      const userSnapshot = await userRef.get()
      const user = userSnapshot.data()

      if (!userSnapshot.exists) {
        return
      }

      const computedRecommendationsSnapshot =
        await computedRecommendationsRef.get()

      if (computedRecommendationsSnapshot.size <= minBatchAllowed) {
        return handleUserRecommendations(user, userRef, false)
      }
      return null
    } catch (error) {
      console.log('updateUserRecommendations', error)
    }
  })
