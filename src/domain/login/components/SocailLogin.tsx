import { FcGoogle } from "react-icons/fc";
import { RiKakaoTalkFill } from "react-icons/ri";
import SocialLoginButton from "./SocialLoginButton";

const redirectToAuth = (provider: "google" | "kakao") => {
  const redirectUri = "http://localhost:3000/auth/callback";
  const authUrl = `${
    import.meta.env.VITE_TEST_URL
  }/oauth/${provider}?redirect_uri=${encodeURIComponent(
    redirectUri
  )}`;

  window.location.href = authUrl;
};

export const SocialLogin = () => {
  return (
    <>
      <SocialLoginButton
        onClick={() => redirectToAuth("google")}
        icon={FcGoogle}
        text="Google"
        colorScheme="gray"
      />
      <SocialLoginButton
        onClick={() => redirectToAuth("kakao")}
        icon={RiKakaoTalkFill}
        text="Kakao"
        bg="#FEE102"
      />
    </>
  );
};
