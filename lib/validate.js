function validate(str) {
  if (!str) {
    return {
      error: "Missing query paramter: app (please enter an appId)",
      valid: false,
    };
  }

  if (typeof str !== "string") {
    return { valid: false, error: "Not a string", type: "type" };
  }

  
  if (str.length > 64) {
    return {
      valid: false,
      error: "ID too looong (max 64 chars)",
      type: "length",
    };
  }
  
  if (str.length < 1) {
    return {
      valid: false,
      error: "IDs shorter than 1 characters are ducked",
      type: "reserved",
    };
  }

  if(!/^[A-Za-z0-9\/\:\.\\_\%\-]+$/.test(str)){
    return {
      valid: false,
      error: "Only alphabets, numbers, slashes, %, _, -, and . are allowed",
      type: "forbidden",
    };
  }

  return { valid: true, id: btoa(str).replaceAll("+", "-").replaceAll("/", "_") };
}

module.exports = { validate };
