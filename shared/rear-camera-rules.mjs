/** Authored rear-camera targets. These are not recovered physical camera extrinsics. */
export const REAR_CAMERA_RULES = Object.freeze({
  version: 1,
  authoredLateralAngleDegrees: 0,
  visualEstimateToleranceDegrees: 8,
  maxShoulderHalfWidthMismatch: 0.20,
  maxShoulderHeightDifferenceRatio: 0.15,
  fullBodyFrameMargin: 0.02
});

/** A request is an instruction for generation; only later image inspection can accept it. */
export function createRearCameraRequirements(pack) {
  const roles = pack.roles.map(role => role.id);
  return {
    format: 'scene-dialogue-rear-camera-requirements', version: REAR_CAMERA_RULES.version,
    status: 'requires_native_image_inspection_and_projection_review',
    stations: [1, 2].map(index => ({
      station: pack.stationOrder[index], foregroundRole: roles[index - 1], dialoguePartner: roles[2 - index],
      cameraPosition: 'directly_behind_foreground_role',
      authoredLateralAngleDegrees: REAR_CAMERA_RULES.authoredLateralAngleDegrees,
      visualEstimateToleranceDegrees: REAR_CAMERA_RULES.visualEstimateToleranceDegrees,
      angleEvidence: 'authored_target_and_optional_visual_estimate_not_measured_camera_extrinsics',
      foregroundOrientation: 'back_facing_camera_with_both_shoulders_visible',
      framingTarget: 'head_to_visible_feet_with_margin_when_not_physically_occluded',
      partnerVisibility: 'speaking_face_visible_or_partly_occluded_by_real_foreground_or_counter',
      gaze: 'both_people_are_talking_to_each_other_not_to_the_camera'
    })),
    observableReview: {
      projection: 'rectilinear_view_from_the_calibrated_panorama_with_recorded_view_and_image_hash',
      shoulderHalfWidthMismatchMax: REAR_CAMERA_RULES.maxShoulderHalfWidthMismatch,
      shoulderHeightDifferenceRatioMax: REAR_CAMERA_RULES.maxShoulderHeightDifferenceRatio,
      fullBodyFrameMargin: REAR_CAMERA_RULES.fullBodyFrameMargin,
      requireBackFacingForeground: true, requirePartnerFaceVisible: true,
      allowUnknownVisualAngleEstimate: true, promptIsNotInspectionEvidence: true
    },
    anatomyAndSpace: {
      preserveIdentitiesClothesAndCounterSides: true,
      noInventedOccludedLegsOrFeet: true,
      recordRealOccluderAndVisibleOutline: true,
      correctHandCountFingersWristsAndCupContact: true,
      noFinishedCoffeeInOrderingStage: true,
      doNotEnlargeCameraSafetyLimitsToFitBadSource: true
    },
    imageWorkflow: {
      generateRearMotherBeforeMatchingDetails: true,
      inspectNativePixelsBeforeCalibration: true,
      recordRuntimeAndNativeSourceHashesSeparately: true,
      calibrateHeadBodyVisibilityCaptureAndUvAgainstActualNewMother: true,
      testAllSupportedPortraitAndLandscapeLayouts: true,
      doNotCopyOldCalibrationOntoChangedPeopleWithoutMeasurement: true
    }
  };
}
