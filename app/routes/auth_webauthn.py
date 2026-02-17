from flask import Blueprint, request, jsonify, session, current_app
from flask_login import login_user, current_user, login_required
from webauthn import (
    generate_registration_options,
    verify_registration_response,
    generate_authentication_options,
    verify_authentication_response,
    options_to_json,
    base64url_to_bytes
)
from webauthn.helpers.structs import (
    AuthenticatorAttachment,
    UserVerificationRequirement,
    ResidentKeyRequirement,
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    PublicKeyCredentialType
)
from app.extensions import db
from app.models import User, UserCredential
import os

webauthn_bp = Blueprint('webauthn', __name__)

def get_webauthn_config():
    """获取动态 WebAuthn 配置"""
    # 优先从配置获取，否则从请求中推断
    # 注意：rp_id 必须是域名（localhost 也可以），不能包含协议或端口
    rp_id = current_app.config.get('WEBAUTHN_RP_ID') or request.host.split(':')[0]
    # origin 必须包含协议和端口
    origin = current_app.config.get('WEBAUTHN_ORIGIN') or f"{request.scheme}://{request.host}"
    return rp_id, origin

RP_NAME = "流光笔记 FluxNote"

@webauthn_bp.route('/webauthn/register/begin', methods=['POST'])
@login_required
def register_begin():
    rp_id, _ = get_webauthn_config()
    user = current_user
    
    exclude_credentials = []
    for cred in user.credentials:
        exclude_credentials.append(PublicKeyCredentialDescriptor(
            id=cred.credential_id,
            type=PublicKeyCredentialType.PUBLIC_KEY
        ))

    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=user.id.encode('utf-8'),
        user_name=user.username,
        exclude_credentials=exclude_credentials if exclude_credentials else None,
        authenticator_selection=AuthenticatorSelectionCriteria(
            user_verification=UserVerificationRequirement.PREFERRED,
            resident_key=ResidentKeyRequirement.PREFERRED
        )
    )

    session['registration_challenge'] = options.challenge
    return options_to_json(options)

@webauthn_bp.route('/webauthn/register/complete', methods=['POST'])
@login_required
def register_complete():
    rp_id, origin = get_webauthn_config()
    challenge = session.get('registration_challenge')
    if not challenge:
        return jsonify({'error': '挑战值已过期，请重试'}), 400

    try:
        registration_verification = verify_registration_response(
            credential=request.json,
            expected_challenge=challenge,
            expected_origin=origin,
            expected_rp_id=rp_id
        )

        new_cred = UserCredential(
            user_id=current_user.id,
            credential_id=registration_verification.credential_id,
            public_key=registration_verification.credential_public_key,
            sign_count=registration_verification.sign_count,
            transports=",".join(request.json.get('response', {}).get('transports', []))
        )
        
        db.session.add(new_cred)
        db.session.commit()

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': f'注册失败: {str(e)}'}), 400

@webauthn_bp.route('/webauthn/login/begin', methods=['POST'])
def login_begin():
    rp_id, _ = get_webauthn_config()
    username = request.json.get('username')
    allow_credentials = []
    
    if username:
        user = User.query.filter_by(username=username).first()
        if user:
            for cred in user.credentials:
                allow_credentials.append(PublicKeyCredentialDescriptor(
                    id=cred.credential_id,
                    type=PublicKeyCredentialType.PUBLIC_KEY
                ))

    options = generate_authentication_options(
        rp_id=rp_id,
        allow_credentials=allow_credentials if allow_credentials else None,
        user_verification=UserVerificationRequirement.PREFERRED
    )

    session['authentication_challenge'] = options.challenge
    return options_to_json(options)

@webauthn_bp.route('/webauthn/login/complete', methods=['POST'])
def login_complete():
    rp_id, origin = get_webauthn_config()
    challenge = session.get('authentication_challenge')
    if not challenge:
        return jsonify({'error': '挑战值已过期，请重试'}), 400

    try:
        credential_id_bytes = base64url_to_bytes(request.json['id'])
        db_cred = UserCredential.query.filter_by(credential_id=credential_id_bytes).first()
        
        if not db_cred:
            return jsonify({'error': '未找到匹配的凭据，请先绑定'}), 401

        authentication_verification = verify_authentication_response(
            credential=request.json,
            expected_challenge=challenge,
            expected_origin=origin,
            expected_rp_id=rp_id,
            credential_public_key=db_cred.public_key,
            credential_current_sign_count=db_cred.sign_count
        )

        db_cred.sign_count = authentication_verification.new_sign_count
        db.session.commit()

        user = User.query.get(db_cred.user_id)
        login_user(user)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': f'认证失败: {str(e)}'}), 400
